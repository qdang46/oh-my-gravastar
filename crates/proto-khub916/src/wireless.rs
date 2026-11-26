//! GravaStar K1 / K98 "916_wireLess" 2.4 GHz dongle transport
//! (Web HubX Pro `916_wireLess` engine class `zt`).
//!
//! **Code-verified only — no wireless hardware was ever attached.** Every
//! layout below is a port of the vendor JS (`docs/research/khub-webapp/
//! index-M8-m9qFR.deob.js`, class `zt`); see `docs/protocol-khub916.md` §3/§7
//! for the spec. Unit tests use synthetic packets only.
//!
//! Transport: HID **output** reports of 19 bytes via `sendReport`
//! ([`Link::write`]) plus an input-report stream ([`Link::read`]).
//!
//! - Query commands send a 7-byte header `[cmd, sub, 0,0,0,0,0]` zero-padded
//!   to 19 bytes. Only the device-info query (cmd 5) appends the additive
//!   checksum; every other query goes out with byte 18 = 0 (verified in the
//!   JS call sites — likely a vendor inconsistency, replicated faithfully).
//! - Large writes are chunked: `[cmd, total&0xFF, index&0xFF, marker,
//!   14 data bytes, checksum]` = 19 bytes. The checksum is
//!   `(reportId + Σ body) & 0xFF` appended right after the body.
//! - Responses are 19-byte input reports `[seq, total, index, flags,
//!   14 payload bytes, checksum]` reassembled by packet index. Keepalive
//!   reports `0A 01 00 04 02 …` feed status listeners and are never routed
//!   to command waiters.
//!
//! Safety: same contract as the wired crate — no generic send API exists;
//! every command is a named method. The factory-reset command (cmd 6) is
//! deliberately **not** implemented (protocol blacklist). Write commands
//! mirror the wired ones: they are implemented because the JS payload
//! layouts are code-verified, each performs a read-back verify, and callers
//! must gate them behind explicit user confirmation.

use std::collections::HashMap;
use std::fmt;
use std::time::{Duration, Instant};

use anyhow::{anyhow, bail, Result};
use omg_hid::devices::KHUB916_WIRELESS;
use omg_hid::Link;
use serde::Serialize;

use crate::{
    catalog_lookup, decode_key_value, screen_size_dims, DeviceInfo, KeyValue, LightColor,
    PowerInfo, Profile, Uuid, WriteOutcome, CUSTOM_LIGHT_ENTRIES, KEYMAP_ENTRIES,
};

// ── Wire constants (docs/protocol-khub916.md §3/§7) ─────────────────────

/// Output/input report body size on the wireless transport.
pub const WIRELESS_REPORT_BYTES: usize = 19;
/// Fixed query header length; responses reuse the same 7-byte fields.
const QUERY_HEADER_LEN: usize = 7;
/// Payload bytes carried by one chunked-write packet (bytes 4..18).
pub const CHUNK_DATA_BYTES: usize = 14;
/// Maximum chunks per write (total-count byte is u8).
pub const MAX_CHUNKS: usize = 255;

/// Per-packet input wait (`He = 5000` in the JS).
const PACKET_WAIT: Duration = Duration::from_millis(5000);
/// Overall reassembly budget (`bt = 20000` in the JS).
const REASSEMBLY_BUDGET: Duration = Duration::from_millis(20_000);
/// Command retry count (`xe = 5` in the JS).
const MAX_ATTEMPTS: usize = 5;

// Wireless command opcodes (docs/protocol-khub916.md §7).
const WL_CMD_KEYMAP_WRITE: u8 = 1;
const WL_CMD_CUSTOM_LIGHT_WRITE: u8 = 2;
const WL_CMD_MACRO_WRITE: u8 = 3;
const WL_CMD_PROFILE_WRITE: u8 = 4;
// 5 = device info, 6 = factory reset (NOT implemented — blacklist).
const WL_CMD_LIGHT_DATA_WRITE: u8 = 9;
const WL_CMD_ADV_KEY_WRITE: u8 = 18;
const WL_CMD_DEVICE_INFO: u8 = 5;
const WL_CMD_KEYMAP_READ: u8 = 65;
const WL_CMD_CUSTOM_LIGHT_READ: u8 = 66;
const WL_CMD_MACRO_READ: u8 = 67;
const WL_CMD_PROFILE_READ: u8 = 68;
const WL_CMD_LIGHT_DATA_READ: u8 = 73;
const WL_CMD_POWER_READ: u8 = 74;
const WL_CMD_ADV_KEY_READ: u8 = 82;

// ── Packet codecs (pure; unit-tested) ────────────────────────────────────

/// Additive checksum: `(reportId + Σ body) & 0xFF` (spec §3).
pub fn checksum(report_id: u8, body: &[u8]) -> u8 {
    let sum = body.iter().fold(report_id as u32, |a, &b| a + b as u32);
    (sum & 0xFF) as u8
}

/// Keepalive/status report: `0A 01 00 04 02 …`, ≥19 bytes (spec §3).
pub fn is_keepalive(report: &[u8]) -> bool {
    report.len() >= WIRELESS_REPORT_BYTES
        && report[0] == 0x0A
        && report[1] == 1
        && report[2] == 0
        && report[3] == 4
        && report[4] == 2
}

/// Status decoded from a keepalive report (the JS `deviceStatus` listener,
/// two interpretations of the same bytes — both are exposed raw-derived):
/// `online = report[5] == 1`; battery view: `remaining = report[5]`,
/// `full = report[6] & 1`, `charging = report[6] & 0x10`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct WirelessStatus {
    pub online: bool,
    /// Byte 5 of the keepalive report (battery "remaining" in the JS
    /// battery listener; equals 1 in the online interpretation).
    pub battery_remaining: u8,
    pub full: bool,
    pub charging: bool,
}

/// Parse a keepalive report into [`WirelessStatus`]; `None` for anything
/// that is not a keepalive.
pub fn parse_status(report: &[u8]) -> Option<WirelessStatus> {
    if !is_keepalive(report) {
        return None;
    }
    Some(WirelessStatus {
        online: report[5] == 1,
        battery_remaining: report[5],
        full: report[6] & 1 != 0,
        charging: report[6] & 0x10 != 0,
    })
}

/// Build a 19-byte output packet: `body` (≤18 bytes) + checksum byte,
/// zero-padded. The checksum sits immediately after the body, matching the
/// JS `new Uint8Array([...body, cs])` + zero-filled `payloadBuffer`.
fn output_packet(report_id: u8, body: &[u8]) -> Result<[u8; WIRELESS_REPORT_BYTES]> {
    if body.len() > WIRELESS_REPORT_BYTES - 1 {
        bail!(
            "916_wireLess packet too large: {} + checksum > {WIRELESS_REPORT_BYTES}",
            body.len()
        );
    }
    let mut pkt = [0u8; WIRELESS_REPORT_BYTES];
    pkt[..body.len()].copy_from_slice(body);
    pkt[body.len()] = checksum(report_id, body);
    Ok(pkt)
}

/// Chunked-write packet body (18 bytes before the checksum):
/// `[cmd, total, index, marker, 14 data bytes]`.
fn chunk_body(
    cmd: u8,
    total: usize,
    index: usize,
    marker: u8,
    data: &[u8; CHUNK_DATA_BYTES],
) -> [u8; 18] {
    debug_assert!(total <= MAX_CHUNKS && index < total);
    let mut body = [0u8; 18];
    body[0] = cmd;
    body[1] = total as u8;
    body[2] = index as u8;
    body[3] = marker;
    body[4..18].copy_from_slice(data);
    body
}

/// 14-byte data chunk padded with zeros (last chunk of a write).
fn chunk14(bytes: &[u8]) -> [u8; CHUNK_DATA_BYTES] {
    debug_assert!(bytes.len() <= CHUNK_DATA_BYTES);
    let mut out = [0u8; CHUNK_DATA_BYTES];
    out[..bytes.len()].copy_from_slice(bytes);
    out
}

/// Payload slice carried by one input report: bytes 4..len-1
/// (`slice(4, len-1)` in the JS — 14 bytes for a full 19-byte report).
fn report_payload(report: &[u8]) -> &[u8] {
    if report.len() > 5 {
        &report[4..report.len() - 1]
    } else {
        &[]
    }
}

// ── Session ──────────────────────────────────────────────────────────────

/// One open `916_wireLess` session over a dongle interface. Input-report
/// reads are pull-based; link errors poison the session (close and reopen),
/// timeouts and framing errors do not.
pub struct Khub916Wireless {
    link: Box<dyn Link>,
    report_id: u8,
    poisoned: bool,
    /// Most recent keepalive report decoded, if any was seen.
    last_status: Option<WirelessStatus>,
}

impl fmt::Debug for Khub916Wireless {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Khub916Wireless")
            .field("report_id", &self.report_id)
            .field("poisoned", &self.poisoned)
            .finish_non_exhaustive()
    }
}

impl Khub916Wireless {
    pub fn new(link: Box<dyn Link>, report_id: u8) -> Self {
        Self {
            link,
            report_id,
            poisoned: false,
            last_status: None,
        }
    }

    pub fn is_poisoned(&self) -> bool {
        self.poisoned
    }

    /// Most recent keepalive status seen while reading (battery/online
    /// listener equivalent). `None` until a keepalive arrives.
    pub fn last_status(&self) -> Option<WirelessStatus> {
        self.last_status
    }

    /// Discovery match: wireless 916 VID/PID only — the JS wireless class
    /// does not check the usage page (it selects the collection by
    /// output+input reports instead, docs/protocol-khub916.md §1).
    pub fn matches(vid: u16, pid: u16) -> bool {
        KHUB916_WIRELESS.contains(&(vid, pid))
    }

    // ── Low-level transport ────────────────────────────────────────────

    /// Write one 19-byte output report. Link errors poison the session.
    fn send(&mut self, pkt: &[u8; WIRELESS_REPORT_BYTES]) -> Result<()> {
        if self.poisoned {
            bail!("916_wireLess session poisoned by an earlier transport error; close and reopen the device");
        }
        match self.link.write(self.report_id, pkt) {
            Ok(()) => Ok(()),
            Err(e) => {
                self.poisoned = true;
                Err(anyhow!("916_wireLess output report failed: {e:#}"))
            }
        }
    }

    /// Read input reports until a non-keepalive one arrives or `timeout`
    /// expires. Keepalives update [`Self::last_status`]. Returns `Ok(None)`
    /// on timeout (not an error — callers decide).
    fn read_data(&mut self, timeout: Duration) -> Result<Option<Vec<u8>>> {
        if self.poisoned {
            bail!("916_wireLess session poisoned by an earlier transport error; close and reopen the device");
        }
        let deadline = Instant::now() + timeout;
        loop {
            let now = Instant::now();
            if now >= deadline {
                return Ok(None);
            }
            match self.link.read(deadline - now) {
                Ok(Some(report)) => {
                    if let Some(status) = parse_status(&report) {
                        self.last_status = Some(status);
                        continue;
                    }
                    return Ok(Some(report));
                }
                Ok(None) => return Ok(None),
                Err(e) => {
                    self.poisoned = true;
                    return Err(anyhow!("916_wireLess input report failed: {e:#}"));
                }
            }
        }
    }

    /// `waitDataPacket`: first non-keepalive report within `timeout`.
    fn wait_data_packet(&mut self, timeout: Duration) -> Result<Vec<u8>> {
        match self.read_data(timeout)? {
            Some(r) => Ok(r),
            None => bail!(
                "916_wireLess input report timeout after {}ms",
                timeout.as_millis()
            ),
        }
    }

    /// Discard pending input reports (the JS clears `incomingPackets` on
    /// every `sendCommand`). Link errors poison the session.
    fn flush_input(&mut self) -> Result<()> {
        loop {
            match self.link.read(Duration::ZERO) {
                Ok(Some(_)) => continue,
                Ok(None) => return Ok(()),
                Err(e) => {
                    self.poisoned = true;
                    return Err(anyhow!("916_wireLess input flush failed: {e:#}"));
                }
            }
        }
    }

    /// Send one packet and return the first non-keepalive response report.
    /// Only for single-report queries (device info, power).
    fn query_once(&mut self, pkt: &[u8; WIRELESS_REPORT_BYTES]) -> Result<Vec<u8>> {
        self.flush_input()?;
        self.send(pkt)?;
        self.wait_data_packet(PACKET_WAIT)
    }

    /// Retry wrapper (`xe = 5` attempts, `min(100, attempt)` ms backoff —
    /// the JS uses ~100 ms for key reads and 1–4 ms elsewhere; the smaller
    /// value is kept for all queries, which is strictly more patient).
    fn with_retries<T>(&mut self, mut f: impl FnMut(&mut Self) -> Result<T>) -> Result<T> {
        let mut last = anyhow!("916_wireLess: no attempt made");
        for attempt in 1..=MAX_ATTEMPTS {
            match f(self) {
                Ok(v) => return Ok(v),
                Err(e) => {
                    last = e;
                    if attempt < MAX_ATTEMPTS {
                        std::thread::sleep(Duration::from_millis((attempt as u64).min(100)));
                    }
                }
            }
        }
        Err(last.context("916_wireLess command failed"))
    }

    /// `parseKeyboardProfile`: collect 19-byte input reports by packet index
    /// until `total` distinct indices arrive (or `expected` payload bytes
    /// are contiguous), within the 20 s budget. Returns the concatenated
    /// `slice(4, len-1)` payloads.
    fn read_profile(&mut self, expected: Option<usize>) -> Result<Vec<u8>> {
        let first = self.wait_data_packet(PACKET_WAIT)?;
        if first.len() < 3 {
            bail!("916_wireLess: first data packet has a format error");
        }
        let total = first[1] as usize;
        if total == 0 {
            bail!("916_wireLess: invalid total packets: 0");
        }
        let mut packets: HashMap<u8, Vec<u8>> = HashMap::new();
        let idx = first[2];
        if (idx as usize) < total {
            packets.insert(idx, first);
        }

        // Contiguous-prefix assembly, exactly like the JS
        // `assembleContiguousPackets` + `o()` early-return: walk indices
        // 0..total, stop at the first gap; succeed early when `expected`
        // bytes are contiguous or when every index has arrived.
        let try_result = |map: &HashMap<u8, Vec<u8>>| -> Option<Vec<u8>> {
            let mut out = Vec::new();
            for i in 0..total {
                match map.get(&(i as u8)) {
                    Some(p) => out.extend_from_slice(report_payload(p)),
                    None => break,
                }
            }
            if let Some(want) = expected {
                if out.len() >= want {
                    out.truncate(want);
                    return Some(out);
                }
            }
            if map.len() == total {
                return Some(out);
            }
            None
        };

        if let Some(v) = try_result(&packets) {
            return Ok(v);
        }

        let deadline = Instant::now() + REASSEMBLY_BUDGET;
        while packets.len() < total {
            let now = Instant::now();
            if now >= deadline {
                if let Some(v) = try_result(&packets) {
                    return Ok(v);
                }
                bail!(
                    "916_wireLess packet count mismatch: expected {total}, got {}",
                    packets.len()
                );
            }
            let per_packet = PACKET_WAIT.min(deadline - now);
            // A per-packet timeout is a command failure in the JS
            // (`waitDataPacket` throws); it is retried by `with_retries`.
            let pkt = self.wait_data_packet(per_packet)?;
            if pkt.len() >= 3 {
                let idx = pkt[2];
                if (idx as usize) < total && !packets.contains_key(&idx) {
                    packets.insert(idx, pkt);
                }
            }
            if let Some(v) = try_result(&packets) {
                return Ok(v);
            }
        }
        // All `total` indices arrived.
        match try_result(&packets) {
            Some(v) => Ok(v),
            None => bail!(
                "916_wireLess packet count mismatch: expected {total}, got {}",
                packets.len()
            ),
        }
    }

    /// Send a 7-byte query header (zero-padded to 19, no checksum — the JS
    /// only checksums the cmd-5 device-info query), then run
    /// [`Self::read_profile`] over the response stream.
    fn transact_profile(
        &mut self,
        header: [u8; QUERY_HEADER_LEN],
        expected: Option<usize>,
    ) -> Result<Vec<u8>> {
        self.with_retries(|s| {
            let mut pkt = [0u8; WIRELESS_REPORT_BYTES];
            pkt[..QUERY_HEADER_LEN].copy_from_slice(&header);
            s.flush_input()?;
            s.send(&pkt)?;
            s.read_profile(expected)
        })
    }

    // ── Reads ──────────────────────────────────────────────────────────

    /// Device info (cmd 5): UUID + firmware version + screen size. This is
    /// also the identification step — the UUID is the catalog "password".
    /// Response is a single 19-byte report: uuid at bytes 4..10, version
    /// 10..12, screen byte 12 (JS `parseUUIDFromResponse`).
    pub fn device_info(&mut self) -> Result<DeviceInfo> {
        self.with_retries(|s| {
            let pkt = output_packet(s.report_id, &[WL_CMD_DEVICE_INFO, 1, 0, 0, 0, 0, 0])?;
            let report = s.query_once(&pkt)?;
            if report.len() < WIRELESS_REPORT_BYTES {
                bail!(
                    "916_wireLess device info: short report {} bytes",
                    report.len()
                );
            }
            let uuid = Uuid(report[4..10].try_into().expect("6 bytes"));
            let version = u16::from_be_bytes([report[10], report[11]]);
            let screen_size = report[12];
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

    /// Keymap u32 values for one layer/system (cmd 65). Query header:
    /// `[65, 0, system<<7, layer<<4, 0,0,0]`. Response = big-endian u32s.
    pub fn key_values(&mut self, layer: u8, system: u8) -> Result<Vec<u32>> {
        let header = [
            WL_CMD_KEYMAP_READ,
            0,
            (system & 1) << 7,
            (layer & 0x0F) << 4,
            0,
            0,
            0,
        ];
        let payload = self.transact_profile(header, None)?;
        if payload.len() % 4 != 0 {
            bail!(
                "916_wireLess keymap: payload {} bytes not a multiple of 4",
                payload.len()
            );
        }
        Ok(payload
            .chunks_exact(4)
            .map(|c| u32::from_be_bytes([c[0], c[1], c[2], c[3]]))
            .collect())
    }

    /// Keymap decoded to [`KeyValue`]s (same encoding as wired).
    pub fn keymap(&mut self, layer: u8, system: u8) -> Result<Vec<KeyValue>> {
        Ok(self
            .key_values(layer, system)?
            .iter()
            .map(|&v| decode_key_value(v))
            .collect())
    }

    /// Custom light colours (cmd 66): reassembled payload = 378 bytes of
    /// R/G/B planes, decoded exactly like the wired cmd 134 reply.
    pub fn custom_light_colors(&mut self) -> Result<Vec<LightColor>> {
        let payload = self.transact_profile(
            [WL_CMD_CUSTOM_LIGHT_READ, 0, 0, 0, 0, 0, 0],
            Some(CUSTOM_LIGHT_ENTRIES * 3),
        )?;
        if payload.len() < CUSTOM_LIGHT_ENTRIES * 3 {
            bail!(
                "916_wireLess custom light: short payload {} bytes",
                payload.len()
            );
        }
        Ok((0..CUSTOM_LIGHT_ENTRIES)
            .map(|i| LightColor {
                index: i,
                pos: (8 + i * 4) as u16,
                r: payload[i],
                g: payload[CUSTOM_LIGHT_ENTRIES + i],
                b: payload[2 * CUSTOM_LIGHT_ENTRIES + i],
            })
            .collect())
    }

    /// Macro region (cmd 67): raw assembled table, ≤512 B.
    pub fn macro_region(&mut self) -> Result<Vec<u8>> {
        self.transact_profile([WL_CMD_MACRO_READ, 0, 0, 0, 0, 0, 0], None)
    }

    /// Profile/config blob (cmd 68): raw reassembled bytes (~128 B).
    pub fn profile(&mut self) -> Result<Profile> {
        let raw = self.transact_profile([WL_CMD_PROFILE_READ, 0, 0, 0, 0, 0, 0], None)?;
        Ok(Profile { raw })
    }

    /// Per-mode light colour/effect blob (cmd 73): raw bytes (~480 B).
    pub fn light_color_data(&mut self) -> Result<Vec<u8>> {
        self.transact_profile([WL_CMD_LIGHT_DATA_READ, 0, 0, 0, 0, 0, 0], None)
    }

    /// Power/battery (cmd 74, sub-command 1): single-report reply,
    /// `level` at byte 4 and packed flags at byte 5 (JS `parseKeyboardPower`:
    /// `charging = (flags>>4)&15 == 1`, `full = flags&15 == 1`). Like every
    /// query except cmd 5, the request goes out WITHOUT a checksum.
    pub fn power(&mut self) -> Result<PowerInfo> {
        self.with_retries(|s| {
            let mut pkt = [0u8; WIRELESS_REPORT_BYTES];
            pkt[..QUERY_HEADER_LEN].copy_from_slice(&[WL_CMD_POWER_READ, 1, 0, 0, 0, 0, 0]);
            let report = s.query_once(&pkt)?;
            if report.len() < 9 {
                bail!("916_wireLess power: short report {} bytes", report.len());
            }
            Ok(PowerInfo {
                percent: report[4],
                flags: report[5],
            })
        })
    }

    /// SOCD/MT/TGL configuration blob (cmd 82): 512 B assembled payload.
    pub fn adv_key_config(&mut self) -> Result<Vec<u8>> {
        self.transact_profile([WL_CMD_ADV_KEY_READ, 0, 0, 0, 0, 0, 0], Some(512))
    }

    // ── Writes (chunked; every one read-back verified) ─────────────────

    /// Send a chunked write. `body_for(index)` returns the 14-byte data
    /// chunk; `marker_for(index, total)` the last-chunk marker semantics are
    /// encoded by the caller via `last_marker` + `last_patch`.
    fn write_chunked(
        &mut self,
        cmd: u8,
        payload: &[u8],
        last_marker: u8,
        last_patch: impl Fn(&mut [u8; 18]),
    ) -> Result<()> {
        let total = payload.len().div_ceil(CHUNK_DATA_BYTES);
        if total == 0 || total > MAX_CHUNKS {
            bail!("916_wireLess write needs 1..={MAX_CHUNKS} chunks, got {total}");
        }
        for index in 0..total {
            let start = index * CHUNK_DATA_BYTES;
            let end = (start + CHUNK_DATA_BYTES).min(payload.len());
            let data = chunk14(&payload[start..end]);
            let is_last = index == total - 1;
            // Non-last chunks always carry marker 14 (the JS literal).
            let marker = if is_last {
                last_marker
            } else {
                CHUNK_DATA_BYTES as u8
            };
            let mut body = chunk_body(cmd, total, index, marker, &data);
            if is_last {
                last_patch(&mut body);
            }
            let pkt = output_packet(self.report_id, &body)?;
            self.send(&pkt)?;
        }
        Ok(())
    }

    /// Write the full keymap (cmd 1). Payload = 128 × u32 BE padded to 512 B.
    ///
    /// Chunk layout follows the `setKeyboardKeys` path in the vendor JS:
    /// byte2 = `(system&1)<<7 | (index&0x7F)`, byte3 = `(layer&0xF)<<4 | 14`
    /// (non-last) / `(layer&0xF)<<4` (last — the JS computes `%14` on the
    /// zero-padded chunk so it is always 0), and the last chunk's first two
    /// data bytes are overwritten with the `5A A5` end marker.
    ///
    /// Verify: cmd 65 read-back must equal `values` exactly.
    pub fn write_keymap(&mut self, layer: u8, system: u8, values: &[u32]) -> Result<WriteOutcome> {
        if values.len() > KEYMAP_ENTRIES {
            bail!(
                "916_wireLess keymap write needs at most {KEYMAP_ENTRIES} values, got {}",
                values.len()
            );
        }
        if values.is_empty() {
            bail!("916_wireLess keymap write needs at least one value");
        }
        let mut payload = vec![0u8; KEYMAP_ENTRIES * 4];
        for (i, v) in values.iter().enumerate() {
            payload[i * 4..i * 4 + 4].copy_from_slice(&v.to_be_bytes());
        }
        let layer_n = layer & 0x0F;
        let system_n = system & 1;
        self.with_retries(|s| {
            // Custom loop: cmd 1's per-chunk header differs from the generic
            // chunked writer (index packed with system bit, layer in byte3).
            let total = payload.len().div_ceil(CHUNK_DATA_BYTES);
            if total > MAX_CHUNKS {
                bail!("916_wireLess keymap write: too many chunks {total}");
            }
            for index in 0..total {
                let start = index * CHUNK_DATA_BYTES;
                let end = (start + CHUNK_DATA_BYTES).min(payload.len());
                let mut data = chunk14(&payload[start..end]);
                let is_last = index == total - 1;
                let mut body = [0u8; 18];
                body[0] = WL_CMD_KEYMAP_WRITE;
                body[1] = total as u8;
                body[2] = (system_n << 7) | (index as u8 & 0x7F);
                body[3] = if is_last {
                    layer_n << 4
                } else {
                    (layer_n << 4) | CHUNK_DATA_BYTES as u8
                };
                if is_last {
                    data[0] = 0x5A;
                    data[1] = 0xA5;
                }
                body[4..18].copy_from_slice(&data);
                let pkt = output_packet(s.report_id, &body)?;
                s.send(&pkt)?;
            }
            let back = s.key_values(layer, system)?;
            if back.len() != values.len() || back.iter().zip(values).any(|(a, b)| a != b) {
                bail!("916_wireLess keymap write not verified: read-back differs");
            }
            Ok(WriteOutcome {
                command: WL_CMD_KEYMAP_WRITE,
                verified: true,
            })
        })
    }

    /// Write the keymap through the vendor `sendKeyConfiguration` path
    /// used by the adv-key setters: the generic chunked cmd-1 write
    /// (`[1,total,index,marker,14 data]` per packet, last marker `0`,
    /// `5A A5` over the last chunk's first two data bytes). `values` is
    /// zero-padded to the 512-byte/128-slot field like `formatKeyPayload`.
    ///
    /// Distinct from [`Self::write_keymap`] (the `setKeyboardKeys` chunk
    /// header); the adv-key flow in the vendor JS always uses this one.
    /// Verify: cmd-65 read-back must equal `values` exactly.
    /// **Code-verified only** — no wireless hardware was ever attached.
    pub fn write_key_configuration(
        &mut self,
        layer: u8,
        system: u8,
        values: &[u32],
    ) -> Result<WriteOutcome> {
        let _ = (layer, system); // the zt sendKeyConfiguration header carries no layer/system
        if values.is_empty() || values.len() > KEYMAP_ENTRIES {
            bail!(
                "916_wireLess key configuration write needs 1..={KEYMAP_ENTRIES} values, got {}",
                values.len()
            );
        }
        let mut payload = vec![0u8; KEYMAP_ENTRIES * 4];
        for (i, v) in values.iter().enumerate() {
            payload[i * 4..i * 4 + 4].copy_from_slice(&v.to_be_bytes());
        }
        self.with_retries(|s| {
            s.write_chunked(WL_CMD_KEYMAP_WRITE, &payload, 0, |body| {
                // Last chunk: vendor writes 5A A5 at body bytes 4/5
                // (first two data bytes).
                body[4] = 0x5A;
                body[5] = 0xA5;
            })?;
            let back = s.key_values(0, 0)?;
            if back.len() != values.len() || back.iter().zip(values).any(|(a, b)| a != b) {
                bail!("916_wireLess key configuration write not verified: read-back differs");
            }
            Ok(WriteOutcome {
                command: WL_CMD_KEYMAP_WRITE,
                verified: true,
            })
        })
    }

    /// Write custom light colours (cmd 2): 378 plane bytes padded to 512 B,
    /// 37 chunks; last-chunk marker is the constant `2` (the JS computes
    /// `%14` on the padded chunk). Verify: cmd 66 read-back planes match.
    pub fn write_custom_light_colors(&mut self, colors: &[crate::Rgb]) -> Result<WriteOutcome> {
        if colors.len() != CUSTOM_LIGHT_ENTRIES {
            bail!(
                "916_wireLess custom light write needs exactly {CUSTOM_LIGHT_ENTRIES} colours, got {}",
                colors.len()
            );
        }
        let mut payload = vec![0u8; KEYMAP_ENTRIES * 4]; // 512 B
        for (i, c) in colors.iter().enumerate() {
            payload[i] = c.r;
            payload[CUSTOM_LIGHT_ENTRIES + i] = c.g;
            payload[2 * CUSTOM_LIGHT_ENTRIES + i] = c.b;
        }
        self.with_retries(|s| {
            s.write_chunked(WL_CMD_CUSTOM_LIGHT_WRITE, &payload, 2, |_| {})?;
            let back = s.custom_light_colors()?;
            let matches = back.len() == colors.len()
                && back
                    .iter()
                    .zip(colors)
                    .all(|(b, w)| (b.r, b.g, b.b) == (w.r, w.g, w.b));
            if !matches {
                bail!("916_wireLess custom light write not verified: read-back differs");
            }
            Ok(WriteOutcome {
                command: WL_CMD_CUSTOM_LIGHT_WRITE,
                verified: true,
            })
        })
    }

    /// Write the macro region (cmd 3): ≤512 B payload, chunked over the
    /// exact length (the JS pads to 512 in some call sites and chunks the
    /// trimmed length in others — device tolerance unknown, code-verified
    /// layout only). Last-chunk marker `2`. Verify: cmd 67 read-back equal.
    pub fn write_macro_region(&mut self, data: &[u8]) -> Result<WriteOutcome> {
        if data.is_empty() || data.len() > KEYMAP_ENTRIES * 4 {
            bail!(
                "916_wireLess macro write needs 1..={} bytes, got {}",
                KEYMAP_ENTRIES * 4,
                data.len()
            );
        }
        self.with_retries(|s| {
            s.write_chunked(WL_CMD_MACRO_WRITE, data, 2, |_| {})?;
            let back = s.macro_region()?;
            if back != data {
                bail!("916_wireLess macro write not verified: read-back differs");
            }
            Ok(WriteOutcome {
                command: WL_CMD_MACRO_WRITE,
                verified: true,
            })
        })
    }

    /// Write the profile/config blob (cmd 4): the ~128 B blob as returned by
    /// [`Self::profile`], chunked over its exact length; last marker `2`.
    /// Verify: cmd 68 read-back equal.
    pub fn write_profile(&mut self, profile: &[u8]) -> Result<WriteOutcome> {
        if profile.is_empty() || profile.len() > KEYMAP_ENTRIES * 4 {
            bail!(
                "916_wireLess profile write needs 1..={} bytes, got {}",
                KEYMAP_ENTRIES * 4,
                profile.len()
            );
        }
        self.with_retries(|s| {
            s.write_chunked(WL_CMD_PROFILE_WRITE, profile, 2, |_| {})?;
            let back = s.profile()?;
            if back.raw != profile {
                bail!("916_wireLess profile write not verified: read-back differs");
            }
            Ok(WriteOutcome {
                command: WL_CMD_PROFILE_WRITE,
                verified: true,
            })
        })
    }

    /// Write the per-mode light colour blob (cmd 9): the ~480 B blob padded
    /// to 512 B → always 37 chunks; last-chunk marker `8` and the last
    /// chunk's data bytes 2..4 are overwritten with `5A A5` (JS
    /// `I[6]=90, I[7]=165` — inside an otherwise all-zero tail chunk).
    /// Verify: cmd 73 read-back prefix equals `data`.
    pub fn write_light_color_data(&mut self, data: &[u8]) -> Result<WriteOutcome> {
        if data.is_empty() || data.len() > KEYMAP_ENTRIES * 4 {
            bail!(
                "916_wireLess light data write needs 1..={} bytes, got {}",
                KEYMAP_ENTRIES * 4,
                data.len()
            );
        }
        let mut payload = vec![0u8; KEYMAP_ENTRIES * 4];
        payload[..data.len()].copy_from_slice(data);
        self.with_retries(|s| {
            s.write_chunked(WL_CMD_LIGHT_DATA_WRITE, &payload, 8, |body| {
                body[6] = 0x5A; // packet byte 6 = data byte 2
                body[7] = 0xA5; // packet byte 7 = data byte 3
            })?;
            let back = s.light_color_data()?;
            if back.len() < data.len() || back[..data.len()] != data[..] {
                bail!("916_wireLess light data write not verified: read-back differs");
            }
            Ok(WriteOutcome {
                command: WL_CMD_LIGHT_DATA_WRITE,
                verified: true,
            })
        })
    }

    /// Write the SOCD/MT/TGL history blob (cmd 18): ≤512 B (the JS always
    /// sends the full 200+200+112 = 512 B), chunked; last marker `0`.
    /// Verify: cmd 82 read-back equal.
    pub fn write_adv_key_history(&mut self, data: &[u8]) -> Result<WriteOutcome> {
        if data.is_empty() || data.len() > KEYMAP_ENTRIES * 4 {
            bail!(
                "916_wireLess adv-key write needs 1..={} bytes, got {}",
                KEYMAP_ENTRIES * 4,
                data.len()
            );
        }
        self.with_retries(|s| {
            s.write_chunked(WL_CMD_ADV_KEY_WRITE, data, 0, |_| {})?;
            let back = s.adv_key_config()?;
            if back != data {
                bail!("916_wireLess adv-key write not verified: read-back differs");
            }
            Ok(WriteOutcome {
                command: WL_CMD_ADV_KEY_WRITE,
                verified: true,
            })
        })
    }
}

/// Probe the output-report id. The JS takes `outputReports[0].reportId`
/// from the descriptor, which hidapi does not expose; this tries the known
/// candidates with the read-only device-info query (cmd 5). Code-verified
/// only — a wrong report id is assumed harmless (the device ignores
/// reports not addressed to it) but this has never run on hardware.
pub fn probe_report_id(link: &mut dyn Link) -> Result<u8> {
    let mut last_err = anyhow!("916_wireLess: no report id answered");
    for id in 1..=32u8 {
        let body = [WL_CMD_DEVICE_INFO, 1, 0, 0, 0, 0, 0];
        let pkt = output_packet(id, &body)?;
        // Flush stale input, send, wait briefly for a 19-byte reply whose
        // payload parses as uuid+version+screen.
        while link.read(Duration::ZERO)?.is_some() {}
        if let Err(e) = link.write(id, &pkt) {
            last_err = anyhow!("report id {id}: write failed: {e:#}");
            continue;
        }
        let deadline = Instant::now() + Duration::from_millis(300);
        loop {
            let now = Instant::now();
            if now >= deadline {
                break;
            }
            match link.read(deadline - now) {
                Ok(Some(report)) => {
                    if is_keepalive(&report) {
                        continue;
                    }
                    if report.len() >= WIRELESS_REPORT_BYTES {
                        return Ok(id);
                    }
                    last_err = anyhow!("report id {id}: short/odd reply ({} bytes)", report.len());
                    break;
                }
                Ok(None) => break,
                Err(e) => {
                    last_err = anyhow!("report id {id}: read failed: {e:#}");
                    break;
                }
            }
        }
        if last_err.to_string().contains(&format!("report id {id}")) {
            // keep last_err as-is
        } else {
            last_err = anyhow!("report id {id}: no answer");
        }
    }
    Err(last_err.context("916_wireLess report id probe failed"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;
    use std::sync::{Arc, Mutex};

    /// Shared mock state so tests can inspect sent packets after the
    /// session owns the link.
    #[derive(Default)]
    struct MockState {
        incoming: VecDeque<Vec<u8>>,
        sent: Vec<(u8, Vec<u8>)>,
        write_err: bool,
    }

    struct MockLink {
        state: Arc<Mutex<MockState>>,
    }

    impl MockLink {
        fn new(incoming: Vec<Vec<u8>>) -> (Self, Arc<Mutex<MockState>>) {
            let state = Arc::new(Mutex::new(MockState {
                incoming: incoming.into(),
                ..Default::default()
            }));
            (
                Self {
                    state: state.clone(),
                },
                state,
            )
        }
    }

    impl Link for MockLink {
        fn write(&mut self, report_id: u8, data: &[u8]) -> Result<()> {
            let mut st = self.state.lock().unwrap();
            if st.write_err {
                bail!("mock write failure");
            }
            st.sent.push((report_id, data.to_vec()));
            Ok(())
        }
        fn read(&mut self, timeout: Duration) -> Result<Option<Vec<u8>>> {
            // Honor the zero-timeout flush probe: nothing "arrived yet".
            if timeout.is_zero() {
                return Ok(None);
            }
            Ok(self.state.lock().unwrap().incoming.pop_front())
        }
        fn feature_exchange(
            &mut self,
            _report_id: u8,
            _payload: &[u8],
            _timeout: Duration,
        ) -> Result<Option<Vec<u8>>> {
            unreachable!("wireless never uses feature reports")
        }
    }

    /// Build a 19-byte input report `[seq,total,index,flags,14 payload,cs]`.
    fn report(total: u8, index: u8, payload14: &[u8]) -> Vec<u8> {
        assert!(payload14.len() <= 14);
        let mut r = vec![0u8; WIRELESS_REPORT_BYTES];
        r[0] = 0x55; // sequence byte (role unconfirmed)
        r[1] = total;
        r[2] = index;
        r[3] = 0;
        r[4..4 + payload14.len()].copy_from_slice(payload14);
        r
    }

    /// Exact-length input report carrying an arbitrary payload (the device
    /// report size is fixed at 19, but the parser accepts any length ≥6 —
    /// useful for payloads that are not a multiple of 14).
    fn report_exact(total: u8, index: u8, payload: &[u8]) -> Vec<u8> {
        let mut r = vec![0u8; 5 + payload.len()];
        r[1] = total;
        r[2] = index;
        r[4..4 + payload.len()].copy_from_slice(payload);
        r
    }

    /// Split `payload` into 14-byte chunks and build out-of-order reports.
    fn response_reports(payload: &[u8], order: &[usize]) -> Vec<Vec<u8>> {
        let total = payload.len().div_ceil(14);
        assert!(total <= 255);
        order
            .iter()
            .map(|&i| {
                let start = i * 14;
                let end = (start + 14).min(payload.len());
                let mut p = [0u8; 14];
                p[..end - start].copy_from_slice(&payload[start..end]);
                report(total as u8, i as u8, &p)
            })
            .collect()
    }

    #[test]
    fn checksum_matches_spec() {
        // cs = (reportId + Σ body) & 0xFF
        assert_eq!(checksum(6, &[1, 2, 3]), 12);
        assert_eq!(checksum(1, &[]), 1);
        assert_eq!(checksum(0xFF, &[0xFF, 0xFF]), (0xFF + 0x1FE) as u8);
        // overflow wraps like the JS `& 255`.
        assert_eq!(checksum(200, &[100, 100]), (200 + 200) as u8);
    }

    #[test]
    fn output_packet_layout() {
        let body = [5u8, 1, 0, 0, 0, 0, 0];
        let pkt = output_packet(6, &body).unwrap();
        assert_eq!(&pkt[..7], &body);
        // checksum at byte 7 = (6 + 5+1) & 0xFF = 12
        assert_eq!(pkt[7], 12);
        assert!(pkt[8..].iter().all(|&b| b == 0));
        // 18-byte body → checksum at byte 18.
        let full = [7u8; 18];
        let pkt2 = output_packet(1, &full).unwrap();
        assert_eq!(pkt2[18], (1 + 7 * 18) as u8);
        assert!(output_packet(1, &[0u8; 19]).is_err());
    }

    #[test]
    fn keepalive_detection_and_status() {
        let mut ka = vec![0u8; 19];
        ka[..5].copy_from_slice(&[0x0A, 1, 0, 4, 2]);
        ka[5] = 87;
        ka[6] = 0x11;
        assert!(is_keepalive(&ka));
        let st = parse_status(&ka).unwrap();
        assert_eq!(st.battery_remaining, 87);
        assert!(st.full);
        assert!(st.charging);
        assert!(!st.online); // 87 != 1
        ka[5] = 1;
        assert!(parse_status(&ka).unwrap().online);
        assert!(!is_keepalive(&[0u8; 18]));
        assert!(parse_status(&[1, 2, 3]).is_none());
        assert!(parse_status(&report(1, 0, &[0u8; 14])).is_none());
    }

    #[test]
    fn chunk_body_layout() {
        let data = [0xABu8; 14];
        let body = chunk_body(4, 3, 1, 14, &data);
        assert_eq!(&body[..4], &[4, 3, 1, 14]);
        assert_eq!(&body[4..], &data);
    }

    #[test]
    fn device_info_query_and_parse() {
        let mut r = vec![0u8; 19];
        r[1] = 1;
        r[4..10].copy_from_slice(&[0x03, 0x00, 0x00, 0x00, 0x01, 0x97]);
        r[10] = 0x01;
        r[11] = 0x00;
        r[12] = 0x02; // screen code 2 = 160x80
        let (link, state) = MockLink::new(vec![r]);
        let mut kb = Khub916Wireless::new(Box::new(link), 6);
        let info = kb.device_info().unwrap();
        assert_eq!(info.uuid.to_string(), "0x030000000197");
        assert_eq!(info.version, 0x0100);
        assert_eq!(info.screen, Some((160, 80)));
        assert_eq!(info.catalog_model.as_deref(), Some("916_K1_PRO"));
        // Sent packet: [5,1,0,0,0,0,0] + checksum at byte 7, rest zero.
        let st = state.lock().unwrap();
        assert_eq!(st.sent.len(), 1);
        let (id, pkt) = &st.sent[0];
        assert_eq!(*id, 6);
        assert_eq!(pkt.len(), 19);
        assert_eq!(&pkt[..7], &[5, 1, 0, 0, 0, 0, 0]);
        assert_eq!(pkt[7], checksum(6, &[5, 1, 0, 0, 0, 0, 0]));
        assert!(pkt[8..].iter().all(|&b| b == 0));
    }

    #[test]
    fn non_info_queries_send_no_checksum() {
        // power query [74,1,0,0,0,0,0] must go out with byte 18 = 0.
        let mut r = vec![0u8; 19];
        r[1] = 1;
        r[4] = 100;
        r[5] = 0x11;
        let (link, state) = MockLink::new(vec![r]);
        let mut kb = Khub916Wireless::new(Box::new(link), 4);
        let p = kb.power().unwrap();
        assert_eq!(p.percent, 100);
        assert_eq!(p.flags, 0x11);
        let st = state.lock().unwrap();
        let (_, pkt) = &st.sent[0];
        assert_eq!(&pkt[..7], &[74, 1, 0, 0, 0, 0, 0]);
        assert!(pkt[7..].iter().all(|&b| b == 0)); // no checksum anywhere
    }

    #[test]
    fn keymap_query_header_and_reassembly() {
        // 8 payload bytes → 1 packet? No: reassembly counts reports, each
        // contributing up to 14 payload bytes; 8 bytes fit in one report.
        // Use total=1, index 0, 8 payload bytes + pad.
        let payload: Vec<u8> = [0x00000029u32, 0x00000035]
            .iter()
            .flat_map(|v| v.to_be_bytes())
            .collect();
        // Exact-length report: 8 payload bytes (14-byte granularity would
        // break the u32 alignment check in key_values).
        let (link, state) = MockLink::new(vec![report_exact(1, 0, &payload)]);
        let mut kb = Khub916Wireless::new(Box::new(link), 4);
        let keys = kb.key_values(0, 0).unwrap();
        assert_eq!(keys, vec![0x00000029, 0x00000035]);
        // Query header [65,0,sys<<7,layer<<4,0,0,0].
        let st = state.lock().unwrap();
        let (_, pkt) = &st.sent[0];
        assert_eq!(&pkt[..7], &[65, 0, 0, 0, 0, 0, 0]);
        // system=1, layer=2 → [65,0,0x80,0x20,0,0,0]
        drop(st);
        let payload2 = vec![report_exact(1, 0, &payload)];
        let (link2, state2) = MockLink::new(payload2);
        let mut kb2 = Khub916Wireless::new(Box::new(link2), 4);
        kb2.key_values(2, 1).unwrap();
        let st2 = state2.lock().unwrap();
        assert_eq!(&st2.sent[0].1[..7], &[65, 0, 0x80, 0x20, 0, 0, 0]);
    }

    #[test]
    fn reassembly_out_of_order_and_early_expected() {
        // 378-byte custom-light payload in 27 packets, delivered reversed.
        let payload: Vec<u8> = (0..378).map(|i| (i % 256) as u8).collect();
        let order: Vec<usize> = (0..27).rev().collect();
        let incoming = response_reports(&payload, &order);
        let (link, _state) = MockLink::new(incoming);
        let mut kb = Khub916Wireless::new(Box::new(link), 4);
        let colors = kb.custom_light_colors().unwrap();
        assert_eq!(colors.len(), CUSTOM_LIGHT_ENTRIES);
        // entry 0: r=payload[0]=0, g=payload[126]=126, b=payload[252]=252
        assert_eq!((colors[0].r, colors[0].g, colors[0].b), (0, 126, 252));
        // entry 1: r=payload[1]=1, g=payload[127]=127, b=payload[253]=253
        assert_eq!((colors[1].r, colors[1].g, colors[1].b), (1, 127, 253));
    }

    #[test]
    fn keepalive_is_skipped_and_status_recorded() {
        let mut ka = vec![0u8; 19];
        ka[..5].copy_from_slice(&[0x0A, 1, 0, 4, 2]);
        ka[5] = 1;
        ka[6] = 0x01;
        let payload = [0x11u8; 14];
        let incoming = vec![ka, report(1, 0, &payload)];
        let (link, _state) = MockLink::new(incoming);
        let mut kb = Khub916Wireless::new(Box::new(link), 4);
        let p = kb.profile().unwrap();
        assert_eq!(p.raw, vec![0x11u8; 14]);
        let st = kb.last_status().unwrap();
        assert!(st.online);
        assert!(st.full);
    }

    #[test]
    fn profile_write_verify_roundtrip_and_chunk_layout() {
        // 16-byte profile → 2 chunks: idx0 14B marker 14, idx1 2B marker 2.
        // Read-back is a single exact-length report carrying the 16 bytes.
        let profile = [0x55u8; 16];
        let (link, state) = MockLink::new(vec![report_exact(1, 0, &profile)]);
        let mut kb = Khub916Wireless::new(Box::new(link), 7);
        let out = kb.write_profile(&profile).unwrap();
        assert!(out.verified);
        assert_eq!(out.command, WL_CMD_PROFILE_WRITE);
        let st = state.lock().unwrap();
        // 2 write packets then 1 query packet.
        assert_eq!(st.sent.len(), 3);
        let c0 = &st.sent[0].1;
        let c1 = &st.sent[1].1;
        assert_eq!(c0[0], WL_CMD_PROFILE_WRITE);
        assert_eq!(&c0[1..4], &[2, 0, 14]); // total, idx, marker=14
        assert_eq!(&c0[4..18], &profile[..14]);
        assert_eq!(c0[18], checksum(7, &c0[..18]));
        assert_eq!(c1[0], WL_CMD_PROFILE_WRITE);
        assert_eq!(&c1[1..4], &[2, 1, 2]); // last marker = 2
        assert_eq!(&c1[4..6], &profile[14..]);
        assert_eq!(c1[18], checksum(7, &c1[..18]));
        // Verify query went out after the writes: cmd 68 header, no checksum.
        let q = &st.sent[2].1;
        assert_eq!(&q[..7], &[68, 0, 0, 0, 0, 0, 0]);
        assert!(q[7..].iter().all(|&b| b == 0));
    }

    #[test]
    fn keymap_write_chunk_layout_and_verify() {
        // values padded to 512 B → 37 chunks; last chunk byte3 = layer<<4,
        // data[0..2] = 5A A5, byte2 = (system<<7)|(idx&0x7F).
        let values = [0x00000029u32, 0x00000035, 0x0000002B];
        // Read-back returns the same 3 u32s as one exact 12-byte report.
        let mut pay = Vec::new();
        for v in values {
            pay.extend_from_slice(&v.to_be_bytes());
        }
        let (link, state) = MockLink::new(vec![report_exact(1, 0, &pay)]);
        let mut kb = Khub916Wireless::new(Box::new(link), 4);
        let out = kb.write_keymap(1, 1, &values).unwrap();
        assert!(out.verified);
        let st = state.lock().unwrap();
        // 37 writes + 1 verify query.
        assert_eq!(st.sent.len(), 38);
        let first = &st.sent[0].1;
        assert_eq!(first[0], WL_CMD_KEYMAP_WRITE);
        // bytes 1..4 = total, byte2=(system<<7)|idx, byte3=(layer<<4)|14.
        assert_eq!(&first[1..4], &[37, 0x80, 0x1E]);
        assert_eq!(first[3], (1 << 4) | 14); // layer<<4 | 14
        let last = &st.sent[36].1;
        assert_eq!(last[0], WL_CMD_KEYMAP_WRITE);
        assert_eq!(last[1], 37);
        assert_eq!(last[2], (1 << 7) | 36);
        assert_eq!(last[3], 1 << 4); // last marker: layer<<4 | 0
        assert_eq!(&last[4..6], &[0x5A, 0xA5]); // end marker overwrote data[0..2]
                                                // byte2 for index ≥128 would mask &0x7F — not exercised (37 chunks).
    }

    #[test]
    fn light_data_write_marker_and_patch() {
        // 480-byte blob padded to 512 → 37 chunks; last marker 8 and the
        // last chunk's data bytes 2..4 = 5A A5 (body bytes 6..8).
        let data = vec![0x77u8; 480];
        // Read-back: return the same 480 bytes (35 packets of 14 = 490 ≥480
        // → expected=480? light_color_data passes None → needs `total`
        // reports all present. Provide ceil(480/14)=35 packets? Reassembly
        // total comes from the FIRST response report's byte1; we control it.
        // Use total=35, indices 0..34 carrying 480 bytes (34*14=476, last
        // carries 4 + pad → contiguous 480 bytes exactly? 35 packets ×14 =
        // 490 payload bytes; assembled = 490 bytes incl. padding. Our verify
        // compares back[..480] == data → ok since padding is zeros after
        // byte 480? No — data is 480 bytes; payload beyond 480 in the last
        // report is zeros, and back.len()=490 ≥480, prefix matches.
        let mut incoming = Vec::new();
        let total = 35u8;
        for i in 0..35usize {
            let start = i * 14;
            let end = (start + 14).min(480);
            let mut p = [0u8; 14];
            if start < 480 {
                p[..end - start].copy_from_slice(&data[start..end]);
            }
            incoming.push(report(total, i as u8, &p));
        }
        let (link, state) = MockLink::new(incoming);
        let mut kb = Khub916Wireless::new(Box::new(link), 4);
        let out = kb.write_light_color_data(&data).unwrap();
        assert!(out.verified);
        let st = state.lock().unwrap();
        assert_eq!(st.sent.len(), 37 + 1); // 37 chunks + verify query
        let last = &st.sent[36].1;
        assert_eq!(last[0], WL_CMD_LIGHT_DATA_WRITE);
        assert_eq!(&last[1..4], &[37, 36, 8]); // last marker = 8
        assert_eq!(&last[6..8], &[0x5A, 0xA5]); // data[2..4] patched
    }

    #[test]
    fn poisoned_on_link_error() {
        let (link, state) = MockLink::new(vec![]);
        state.lock().unwrap().write_err = true;
        let mut kb = Khub916Wireless::new(Box::new(link), 4);
        assert!(kb.device_info().is_err());
        assert!(kb.is_poisoned());
        assert!(kb.power().is_err()); // fails fast, no more link calls
    }

    #[test]
    fn macro_region_raw_passthrough() {
        // 98 bytes = exactly 7 full 14-byte chunks → assembled == payload.
        let payload: Vec<u8> = (0..98).map(|i| i as u8).collect();
        let order: Vec<usize> = (0..7).rev().collect();
        let incoming = response_reports(&payload, &order);
        let (link, _state) = MockLink::new(incoming);
        let mut kb = Khub916Wireless::new(Box::new(link), 4);
        let m = kb.macro_region().unwrap();
        assert_eq!(m.len(), 98);
        assert_eq!(m, payload);
    }

    #[test]
    fn write_rejections() {
        let (link, _state) = MockLink::new(vec![]);
        let mut kb = Khub916Wireless::new(Box::new(link), 4);
        assert!(kb.write_profile(&[]).is_err());
        assert!(kb.write_profile(&[0u8; 513]).is_err());
        assert!(kb.write_macro_region(&[]).is_err());
        assert!(kb.write_keymap(0, 0, &[]).is_err());
        assert!(kb
            .write_custom_light_colors(&vec![crate::Rgb::default(); CUSTOM_LIGHT_ENTRIES - 1])
            .is_err());
        assert!(kb.write_adv_key_history(&[0u8; 513]).is_err());
        assert!(kb.write_light_color_data(&[0u8; 513]).is_err());
    }

    #[test]
    fn serde_wireless_status() {
        let st = WirelessStatus {
            online: true,
            battery_remaining: 1,
            full: true,
            charging: false,
        };
        let j = serde_json::to_value(st).unwrap();
        assert_eq!(j["online"], true);
        assert_eq!(j["battery_remaining"], 1);
    }
}
