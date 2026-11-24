//! SparkPlayJoy 6x21 analog protocol — GravaStar Mercury HE keyboards
//! (Mercury V75 / V75 Pro / V75 Lite).
//!
//! Wire format (`docs/protocol-sparkplayjoy.md`, ported from HallJoy
//! `aula_win60he_protocol` / `aula_win60he_client`, MIT):
//!
//! ```text
//! offset 0      1            2        3          4 .. 4+len-1   rest
//! +------------+------------+--------+----------+----------------+--------+
//! | 0x5C head  | payload len | command| checksum|    payload     | zero   |
//! +------------+------------+--------+----------+----------------+--------+
//! ```
//!
//! - `payload len` counts payload bytes only; max 60 per 64-byte report.
//!   Longer responses span `ceil((4+len)/64)` reports (max 3 = 192 bytes);
//!   the frame is parsed on the concatenated stream, response command =
//!   request | 0x80. All multi-byte integers are little-endian.
//! - Checksum: `cs = (0x35 + 0x5C + len + cmd + payload[len-1]) & 0xFF`
//!   (last term omitted when `len == 0`).
//! - The device declares no HID report ID. The Win32 envelope is 65 bytes:
//!   byte 0 = report id (always 0x00), bytes 1..64 = the protocol report.
//!   Reads therefore arrive as 65 bytes; [`protocol_report`] strips the
//!   leading byte after checking it is 0 (a bare 64-byte report is also
//!   accepted for platforms whose hidapi omits the id byte).
//!
//! # Safety (docs/plan.md §2)
//!
//! **Read-only.** The protocol's only known commands are reads; this crate
//! implements no write path at all. Every transaction flushes the input
//! queue first (responses carry no transaction id), reads a fixed report
//! count under one shared deadline, and any flush/write/read/parse/
//! correlation error permanently poisons the session — the caller must
//! close and reopen the device.
//!
//! # Admission (spec §5)
//!
//! [`SparkPlayJoy::prove_identity`] performs the wire-side structural proof:
//! sync board match (when an expected board is supplied), scale plausibility,
//! default-map uniqueness, two byte-identical active-map generations, and
//! travel within `max + max(8*precision, 200)` µm. HID caps (usage page
//! 0xFFA0 / usage 1, 65-byte reports) are the caller's job — see
//! `omg_hid::classify` / `DeviceInfo`.

use std::time::Duration;

use anyhow::{anyhow, bail, Result};
use omg_hid::{transfer_exact, Link};
use serde::Serialize;

// ── Wire constants (docs/protocol-sparkplayjoy.md §1/§2) ───────────────

pub const FRAME_HEAD: u8 = 0x5C;
pub const WIRE_REPORT_BYTES: usize = 64;
pub const MAX_RESPONSE_REPORTS: usize = 3;
pub const MAX_RESPONSE_BYTES: usize = WIRE_REPORT_BYTES * MAX_RESPONSE_REPORTS;
/// Win32 HIDP_CAPS report length: report-id byte + 64 protocol bytes.
pub const HID_ENVELOPE_BYTES: usize = WIRE_REPORT_BYTES + 1;

pub const ROWS: usize = 6;
pub const COLS: usize = 21;
pub const MATRIX_POSITIONS: usize = ROWS * COLS;
const ROWS_PER_TRAVEL_HALF: usize = 3;
const TRAVEL_VALUES_PER_HALF: usize = ROWS_PER_TRAVEL_HALF * COLS;

const CMD_API: u8 = 0x00;
const CMD_SYNC: u8 = 0x01;
const CMD_MATRIX: u8 = 0x12;
const CMD_KEY_FUNCTIONS: u8 = 0x23;
const CMD_DEFAULT_KEYS: u8 = 0x2b;

const ORDER_PRECISION: u8 = 0x25;
const SELECTOR_TRAVEL: u8 = 0x02;
const SELECTOR_STATUS: u8 = 0x03;
const LAYOUT_FN0: u8 = 0x00;

const KEY_FUNCTION_RECORDS: usize = 14;
const KEY_FUNCTION_PAYLOAD: usize = 1 + KEY_FUNCTION_RECORDS * 4; // 57
const SYNC_PAYLOAD: usize = 60;
const SCALE_PAYLOAD: usize = 7;
const DEFAULT_MAP_PAYLOAD: usize = 45;
const TRAVEL_PAYLOAD: usize = 2 + TRAVEL_VALUES_PER_HALF * 2; // 128
const STATUS_PAYLOAD: usize = 2 + MATRIX_POSITIONS + 2; // 130

/// One transaction deadline, shared across continuation reads.
const TRANSACTION_TIMEOUT: Duration = Duration::from_millis(1000);

// ── Identity table (spec §4) ───────────────────────────────────────────

/// A GravaStar SparkPlayJoy board identity from the verified table.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct KnownIdentity {
    pub model: &'static str,
    pub vid: u16,
    pub pid: u16,
    /// Board id returned by sync at payload bytes 1..4 (LE u32).
    pub board_id: u32,
}

/// Exact USB/board identities with firmware proof. Only these may claim an
/// exact known board; unknown VID:PID pairs get a structural proof only.
pub const KNOWN_IDENTITIES: [KnownIdentity; 3] = [
    KnownIdentity {
        model: "Mercury V75",
        vid: 0x1ca5,
        pid: 0x2201,
        board_id: 0x1605_2201,
    },
    KnownIdentity {
        model: "Mercury V75 Pro",
        vid: 0x1ca5,
        pid: 0x2202,
        board_id: 0x1605_2202,
    },
    KnownIdentity {
        model: "Mercury V75 Lite",
        vid: 0x1ca2,
        pid: 0x2201,
        board_id: 0x2e02_2201,
    },
];

/// Exact-table board id for a VID:PID, if known.
pub fn known_board_id(vid: u16, pid: u16) -> Option<u32> {
    KNOWN_IDENTITIES
        .iter()
        .find(|i| i.vid == vid && i.pid == pid)
        .map(|i| i.board_id)
}

// ── Public data types ──────────────────────────────────────────────────

/// Default physical map: matrix position → factory HID usage byte
/// (0 = unpopulated). Row-major, 6×21.
pub type KeyMap = [[u8; COLS]; ROWS];

/// Raw 16-bit Fn0 function per matrix position (0 where unmapped).
pub type FunctionMap = [[u16; COLS]; ROWS];

/// Decoded publishable function per matrix position.
///
/// - [`KeyFunction::HidUsage`] — wire value 0x0004..=0x00E7 (USB HID usage).
/// - [`KeyFunction::Fn`] — wire value 0xF001, the physical Fn key. Never
///   truncate it to a byte-sized usage.
/// - `None` — filtered values (other 0xFxxx, macros, internals); never
///   published.
pub type ActiveKeyMap = [[Option<KeyFunction>; COLS]; ROWS];

/// Live travel samples in micrometres, `samples_um[row][col]`, 6×21.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
pub struct TravelMatrix {
    pub samples_um: [[u16; COLS]; ROWS],
}

/// One half of the travel matrix: 3 rows × 21 cols of u16 µm values.
pub type TravelHalf = [[u16; COLS]; ROWS_PER_TRAVEL_HALF];

/// Decoded key function from a 0x23 record.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum KeyFunction {
    /// USB HID keyboard usage 0x04..=0xE7.
    HidUsage(u8),
    /// Physical Fn key (wire value 0xF001).
    Fn,
}

/// Decode a raw 16-bit Fn0 function. `None` = filtered, never published.
pub fn decode_key_function(function: u16) -> Option<KeyFunction> {
    match function {
        0x0004..=0x00e7 => Some(KeyFunction::HidUsage(function as u8)),
        0xf001 => Some(KeyFunction::Fn),
        _ => None,
    }
}

/// Sync (cmd 0x01) response contents.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct SyncInfo {
    /// Board id, payload bytes 1..4 little-endian.
    pub board_id: u32,
    /// Platform bytes 5..7. Semantics unknown — never compared across models.
    pub platform: [u8; 3],
    /// 16-byte printable serial descriptor.
    pub serial: String,
    /// 16-byte app descriptor, e.g. "App V1.0.8".
    pub app_version: String,
    /// 7-byte build label prefix of the 16-byte build descriptor.
    pub build_label: String,
    /// Full 60-byte payload for diagnostics.
    pub raw_payload: Vec<u8>,
}

/// Travel scale (cmd 0x00, order 0x25) response contents.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct TravelScale {
    /// Smallest resolvable travel step, micrometres (1..=100).
    pub precision_um: u16,
    pub minimum_travel_um: u16,
    /// Live maximum travel, micrometres (500..=10000). Never hardcode.
    pub maximum_travel_um: u16,
}

/// One batch of 14 key-function query records.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct KeyFunctionQuery {
    /// Factory key bytes (default-map HID usages), row-major, nonzero only.
    pub keys: [u8; KEY_FUNCTION_RECORDS],
    /// Number of leading `keys` entries that are real (rest are padding).
    pub count: usize,
}

/// Result of one complete active-map generation.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct ActiveMap {
    /// Raw function values at each populated matrix position.
    pub functions: FunctionMap,
    /// Publishable decode of `functions` (filtered values become `None`).
    pub keys: ActiveKeyMap,
}

/// Successful admission proof (spec §5). `exact_known_board` is true only
/// when the caller supplied the table board id for the VID:PID and it
/// matched; unknown devices always get a structural-only proof.
#[derive(Clone, Debug, Serialize)]
pub struct Admission {
    pub sync: SyncInfo,
    pub scale: TravelScale,
    pub default_map: KeyMap,
    pub active_map: ActiveMap,
    pub travel: TravelMatrix,
    pub board_id: u32,
    pub exact_known_board: bool,
}

// ── Frame build / parse ────────────────────────────────────────────────

/// `cs = (0x35 + 0x5C + len + cmd + payload[len-1]) & 0xFF`;
/// the last-payload term is omitted when `len == 0`.
pub fn checksum(payload_len: u8, command: u8, payload: &[u8]) -> u8 {
    let mut sum = 0x35u16 + FRAME_HEAD as u16 + payload_len as u16 + command as u16;
    if payload_len != 0 {
        if let Some(&last) = payload.get(payload_len as usize - 1) {
            sum += last as u16;
        }
    }
    (sum & 0xFF) as u8
}

/// Build one 64-byte zero-padded protocol report.
///
/// Returns `None` when `payload` exceeds 60 bytes (max per report) or 255.
pub fn build_frame(command: u8, payload: &[u8]) -> Option<[u8; WIRE_REPORT_BYTES]> {
    if payload.len() > WIRE_REPORT_BYTES - 4 || payload.len() > 0xFF {
        return None;
    }
    let mut frame = [0u8; WIRE_REPORT_BYTES];
    frame[0] = FRAME_HEAD;
    frame[1] = payload.len() as u8;
    frame[2] = command;
    frame[3] = checksum(frame[1], command, payload);
    frame[4..4 + payload.len()].copy_from_slice(payload);
    Some(frame)
}

/// Number of 64-byte reports a frame of `payload_len` bytes spans.
pub fn response_report_count(payload_len: usize) -> usize {
    (4 + payload_len).div_ceil(WIRE_REPORT_BYTES)
}

/// A parsed response frame: view into the concatenated report stream.
#[derive(Clone, Copy, Debug)]
pub struct FrameView<'a> {
    pub command: u8,
    pub payload: &'a [u8],
}

/// Parse one frame at offset 0 of a concatenated multi-report stream.
/// `stream` must hold at least `ceil((4+len)/64)` reports already
/// concatenated; trailing bytes are ignored but the frame must fit.
pub fn parse_frame<'a>(stream: &'a [u8], request_command: u8) -> Result<FrameView<'a>> {
    if stream.len() < 4 || stream[0] != FRAME_HEAD {
        bail!(
            "response frame: bad head or short stream ({} bytes)",
            stream.len()
        );
    }
    let payload_len = stream[1] as usize;
    let command = stream[2];
    let expected_cmd = request_command | 0x80;
    if command != expected_cmd {
        bail!("response frame: command 0x{command:02x}, expected 0x{expected_cmd:02x}");
    }
    let frame_bytes = 4 + payload_len;
    if frame_bytes > stream.len() {
        bail!(
            "response frame: payload len {payload_len} needs {frame_bytes} bytes, have {}",
            stream.len()
        );
    }
    if frame_bytes > MAX_RESPONSE_BYTES {
        bail!("response frame: payload len {payload_len} exceeds {MAX_RESPONSE_BYTES}-byte cap");
    }
    let payload = &stream[4..frame_bytes];
    let cs = checksum(stream[1], command, payload);
    if cs != stream[3] {
        bail!(
            "response frame: checksum 0x{:02x}, expected 0x{:02x}",
            stream[3],
            cs
        );
    }
    Ok(FrameView { command, payload })
}

/// Strip the Win32 report-id byte from one input report.
///
/// Accepts the 65-byte envelope (byte 0 must be 0x00) or a bare 64-byte
/// protocol report. Anything else is a transport anomaly.
pub fn protocol_report(report: &[u8]) -> Result<[u8; WIRE_REPORT_BYTES]> {
    let mut out = [0u8; WIRE_REPORT_BYTES];
    match report.len() {
        HID_ENVELOPE_BYTES => {
            if report[0] != 0 {
                bail!(
                    "HID envelope: report id byte 0x{:02x}, expected 0x00",
                    report[0]
                );
            }
            out.copy_from_slice(&report[1..]);
        }
        WIRE_REPORT_BYTES => out.copy_from_slice(report),
        n => bail!(
            "HID report: {} bytes, expected {WIRE_REPORT_BYTES} or {HID_ENVELOPE_BYTES}",
            n
        ),
    }
    Ok(out)
}

// ── Payload decoders ───────────────────────────────────────────────────

fn rd16le(d: &[u8], i: usize) -> u16 {
    u16::from_le_bytes([d[i], d[i + 1]])
}

/// Decode a sync payload (60 bytes) with the structural checks of spec §2.1.
pub fn decode_sync(payload: &[u8]) -> Result<SyncInfo> {
    if payload.len() != SYNC_PAYLOAD {
        bail!(
            "sync payload: {} bytes, expected {SYNC_PAYLOAD}",
            payload.len()
        );
    }
    let p = payload;
    if p[0] != 0 {
        bail!("sync payload: status byte 0x{:02x}, expected 0", p[0]);
    }
    if p[8] != 0x10 || p[25] != 0x10 || p[42] != 0x10 {
        bail!("sync payload: descriptor length bytes are not all 0x10");
    }
    if p[59] != 0xFF {
        bail!("sync payload: trailer 0x{:02x}, expected 0xFF", p[59]);
    }
    let board_id = u32::from_le_bytes([p[1], p[2], p[3], p[4]]);
    if board_id == 0 {
        bail!("sync payload: board id is zero");
    }
    let printable = |bytes: &[u8]| -> bool {
        let mut meaningful = false;
        for &b in bytes {
            if b == 0 {
                continue;
            }
            if !(0x20..=0x7e).contains(&b) {
                return false;
            }
            meaningful = true;
        }
        meaningful
    };
    let cstr = |bytes: &[u8]| -> String {
        bytes
            .iter()
            .take_while(|&&b| b != 0)
            .map(|&b| b as char)
            .collect()
    };
    let serial = &p[9..25];
    let app = &p[26..42];
    let build = &p[43..59];
    let app_version = cstr(app);
    if !app_version.starts_with("App V") || !printable(app) || !printable(build) {
        bail!(
            "sync payload: app descriptor {:?} fails the 'App V'/printable checks",
            app_version
        );
    }
    if !printable(serial) {
        bail!("sync payload: serial descriptor is not printable ASCII");
    }
    Ok(SyncInfo {
        board_id,
        platform: [p[5], p[6], p[7]],
        serial: cstr(serial),
        app_version,
        build_label: cstr(&build[..7]),
        raw_payload: payload.to_vec(),
    })
}

/// Decode a scale payload (7 bytes) with family plausibility bounds (spec §2.2).
pub fn decode_scale(payload: &[u8]) -> Result<TravelScale> {
    if payload.len() != SCALE_PAYLOAD {
        bail!(
            "scale payload: {} bytes, expected {SCALE_PAYLOAD}",
            payload.len()
        );
    }
    if payload[0] != 0 || payload[1] != ORDER_PRECISION {
        bail!(
            "scale payload: bad status/order echo {:02x}/{:02x}",
            payload[0],
            payload[1]
        );
    }
    let scale = TravelScale {
        precision_um: payload[2] as u16,
        minimum_travel_um: rd16le(payload, 3),
        maximum_travel_um: rd16le(payload, 5),
    };
    if !(1..=100).contains(&scale.precision_um)
        || scale.minimum_travel_um > scale.maximum_travel_um
        || !(500..=10000).contains(&scale.maximum_travel_um)
    {
        bail!("scale payload: implausible {:?}", scale);
    }
    Ok(scale)
}

/// Decode one default-map response (45 bytes) into `map` rows
/// `first_row`/`second_row`.
pub fn decode_default_map_rows(
    payload: &[u8],
    first_row: u8,
    second_row: u8,
    map: &mut KeyMap,
) -> Result<()> {
    if payload.len() != DEFAULT_MAP_PAYLOAD {
        bail!(
            "default-map payload: {} bytes, expected {DEFAULT_MAP_PAYLOAD}",
            payload.len()
        );
    }
    if first_row as usize >= ROWS || second_row as usize >= ROWS || first_row == second_row {
        bail!("default-map rows {first_row}/{second_row} out of range");
    }
    if payload[0] != 0 || payload[1] != first_row || payload[23] != second_row {
        bail!(
            "default-map payload: echo mismatch status={:02x} rows={:02x}/{:02x}",
            payload[0],
            payload[1],
            payload[23]
        );
    }
    map[first_row as usize][..COLS].copy_from_slice(&payload[2..2 + COLS]);
    map[second_row as usize][..COLS].copy_from_slice(&payload[24..24 + COLS]);
    Ok(())
}

/// One decoded 0x23 record.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct KeyFunctionRecord {
    pub key: u8,
    pub layout: u8,
    pub function: u16,
}

/// Decode a 0x23 response (57 bytes) and check every echo against `query`.
///
/// All key/layout echoes must correlate; the final short batch is padded by
/// repeating its last real key and every duplicate echo must return an
/// identical function value (pad-repeat-last semantics, spec §2.4).
pub fn decode_key_function_response(
    payload: &[u8],
    query: &KeyFunctionQuery,
) -> Result<[KeyFunctionRecord; KEY_FUNCTION_RECORDS]> {
    if payload.len() != KEY_FUNCTION_PAYLOAD {
        bail!(
            "key-function payload: {} bytes, expected {KEY_FUNCTION_PAYLOAD}",
            payload.len()
        );
    }
    if payload[0] != 0 {
        bail!(
            "key-function payload: status byte 0x{:02x}, expected 0",
            payload[0]
        );
    }
    if query.count == 0 || query.count > KEY_FUNCTION_RECORDS {
        bail!("key-function query: count {} out of range", query.count);
    }
    let mut out = [KeyFunctionRecord {
        key: 0,
        layout: 0,
        function: 0,
    }; KEY_FUNCTION_RECORDS];
    for i in 0..KEY_FUNCTION_RECORDS {
        let off = 1 + i * 4;
        let record = KeyFunctionRecord {
            key: payload[off],
            layout: payload[off + 1],
            function: rd16le(payload, off + 2),
        };
        if record.key != query.keys[i] || record.layout != LAYOUT_FN0 || record.key == 0 {
            bail!(
                "key-function record {i}: echo {}/{} does not match query {}/{}",
                record.key,
                record.layout,
                query.keys[i],
                LAYOUT_FN0
            );
        }
        for prev in out.iter().take(i) {
            if prev.key == record.key && prev.function != record.function {
                bail!("key-function record {i}: duplicate key 0x{:02x} returned inconsistent functions", record.key);
            }
        }
        out[i] = record;
    }
    Ok(out)
}

/// Apply one decoded batch to `functions`: each record's factory key must
/// resolve to exactly one populated default-map position.
pub fn apply_key_function_batch(
    default_map: &KeyMap,
    records: &[KeyFunctionRecord; KEY_FUNCTION_RECORDS],
    functions: &mut FunctionMap,
) -> Result<()> {
    for record in records {
        if record.layout != LAYOUT_FN0 {
            bail!(
                "key-function record: layout 0x{:02x}, expected Fn0",
                record.layout
            );
        }
        let mut found = None;
        for (r, row) in default_map.iter().enumerate() {
            for (c, &key) in row.iter().enumerate() {
                if key == record.key {
                    if found.is_some() {
                        bail!("key-function record: factory key 0x{:02x} is not unique in the default map", record.key);
                    }
                    found = Some((r, c));
                }
            }
        }
        let Some((r, c)) = found else {
            bail!(
                "key-function record: factory key 0x{:02x} not present in the default map",
                record.key
            );
        };
        functions[r][c] = record.function;
    }
    Ok(())
}

/// Decode a travel-half payload (128 bytes) into 3×21 u16 µm samples.
pub fn decode_travel_half(payload: &[u8]) -> Result<TravelHalf> {
    if payload.len() != TRAVEL_PAYLOAD {
        bail!(
            "travel payload: {} bytes, expected {TRAVEL_PAYLOAD}",
            payload.len()
        );
    }
    if payload[0] != 0 || payload[1] != SELECTOR_TRAVEL {
        bail!(
            "travel payload: bad status/selector {:02x}/{:02x}",
            payload[0],
            payload[1]
        );
    }
    let mut half = [[0u16; COLS]; ROWS_PER_TRAVEL_HALF];
    for (r, row) in half.iter_mut().enumerate() {
        for (c, cell) in row.iter_mut().enumerate() {
            *cell = rd16le(payload, 2 + (r * COLS + c) * 2);
        }
    }
    Ok(half)
}

/// Decode a status payload (130 bytes) into the 6×21 status matrix.
/// Implemented per spec §2.6; not used in steady-state polling.
pub fn decode_status(payload: &[u8]) -> Result<[[u8; COLS]; ROWS]> {
    if payload.len() != STATUS_PAYLOAD {
        bail!(
            "status payload: {} bytes, expected {STATUS_PAYLOAD}",
            payload.len()
        );
    }
    if payload[0] != 0 || payload[1] != SELECTOR_STATUS {
        bail!(
            "status payload: bad status/selector {:02x}/{:02x}",
            payload[0],
            payload[1]
        );
    }
    if payload[STATUS_PAYLOAD - 2] != 0xFF || payload[STATUS_PAYLOAD - 1] != 0xFF {
        bail!("status payload: missing 0xFFFF trailer");
    }
    let mut matrix = [[0u8; COLS]; ROWS];
    for r in 0..ROWS {
        for c in 0..COLS {
            matrix[r][c] = payload[2 + r * COLS + c];
        }
    }
    Ok(matrix)
}

/// Merge two travel halves: half 1 → rows 0..2, half 2 → rows 3..5.
pub fn merge_travel_halves(first: &TravelHalf, second: &TravelHalf) -> TravelMatrix {
    let mut matrix = TravelMatrix::default();
    matrix.samples_um[..ROWS_PER_TRAVEL_HALF].copy_from_slice(&first[..ROWS_PER_TRAVEL_HALF]);
    matrix.samples_um[ROWS_PER_TRAVEL_HALF..].copy_from_slice(&second[..ROWS_PER_TRAVEL_HALF]);
    matrix
}

/// Normalize raw µm travel to 0..=1000 milli against the live maximum.
pub fn normalize_travel_to_milli(travel_um: u16, maximum_travel_um: u16) -> u16 {
    if travel_um == 0 || maximum_travel_um == 0 {
        return 0;
    }
    if travel_um >= maximum_travel_um {
        return 1000;
    }
    let scaled =
        (travel_um as u32 * 1000 + maximum_travel_um as u32 / 2) / maximum_travel_um as u32;
    scaled.min(1000) as u16
}

// ── Request builders ───────────────────────────────────────────────────

fn req(command: u8, payload: &[u8]) -> [u8; WIRE_REPORT_BYTES] {
    build_frame(command, payload).expect("request payloads are small")
}

/// Sync request: payload `01 02 03 04 FF FF`, frame `5C 06 01 <cs> …`.
pub fn sync_request() -> [u8; WIRE_REPORT_BYTES] {
    req(CMD_SYNC, &[0x01, 0x02, 0x03, 0x04, 0xFF, 0xFF])
}

/// Scale request: cmd 0x00, order 0x25, payload `25 FF FF`.
pub fn scale_request() -> [u8; WIRE_REPORT_BYTES] {
    req(CMD_API, &[ORDER_PRECISION, 0xFF, 0xFF])
}

/// Default-map request for two rows: payload `00 <first> <second>`.
pub fn default_map_request(first_row: u8, second_row: u8) -> [u8; WIRE_REPORT_BYTES] {
    req(CMD_DEFAULT_KEYS, &[0x00, first_row, second_row])
}

/// Active Fn0 function query: `00` + 14 × `{key, layout, 0, 0}`.
pub fn key_function_request(query: &KeyFunctionQuery) -> [u8; WIRE_REPORT_BYTES] {
    let mut payload = [0u8; KEY_FUNCTION_PAYLOAD];
    payload[0] = 0x00;
    for i in 0..KEY_FUNCTION_RECORDS {
        let off = 1 + i * 4;
        payload[off] = query.keys[i];
        payload[off + 1] = LAYOUT_FN0;
    }
    req(CMD_KEY_FUNCTIONS, &payload)
}

/// Live travel request for half 1 (rows 0..2) or 2 (rows 3..5).
/// Exact verified frames: `5C 04 12 A6 02 <half> FF FF`.
pub fn travel_request(half: u8) -> [u8; WIRE_REPORT_BYTES] {
    req(CMD_MATRIX, &[SELECTOR_TRAVEL, half, 0xFF, 0xFF])
}

/// Status request: selector 0x03, payload `03 01 FF FF`.
pub fn status_request() -> [u8; WIRE_REPORT_BYTES] {
    req(CMD_MATRIX, &[SELECTOR_STATUS, 0x01, 0xFF, 0xFF])
}

// ── Client ─────────────────────────────────────────────────────────────

/// SparkPlayJoy 6x21 session over a [`Link`].
///
/// Poison semantics (spec §3/§8): there is no transaction id, so any
/// flush/write/read/parse/correlation error means queued reports may be
/// misattributed. The first such error permanently poisons the session;
/// every later call fails fast until the device is reopened.
pub struct SparkPlayJoy {
    link: Box<dyn Link>,
    poisoned: bool,
}

impl SparkPlayJoy {
    pub fn new(link: Box<dyn Link>) -> Self {
        Self {
            link,
            poisoned: false,
        }
    }

    /// True once a transport or decode error has poisoned the session.
    pub fn is_poisoned(&self) -> bool {
        self.poisoned
    }

    /// Discovery match: usage page 0xFFA0, usage 1 (VID/PID only select the
    /// expected board via [`known_board_id`]).
    pub fn matches(usage_page: u16, usage: u16) -> bool {
        usage_page == omg_hid::devices::SPARKPLAYJOY_USAGE_PAGE
            && usage == omg_hid::devices::SPARKPLAYJOY_USAGE
    }

    fn guard<T>(&mut self, f: impl FnOnce(&mut Self) -> Result<T>) -> Result<T> {
        if self.poisoned {
            bail!("sparkplayjoy session poisoned by an earlier transport/decode error; close and reopen the device");
        }
        let result = f(self);
        if result.is_err() {
            self.poisoned = true;
        }
        result
    }

    /// One transaction: flush → write → read `reports` 64-byte reports under
    /// one shared deadline → concatenate → parse the single frame → verify
    /// the response report count matches the declared payload length.
    fn transact(
        &mut self,
        request: &[u8; WIRE_REPORT_BYTES],
        request_cmd: u8,
        reports: usize,
    ) -> Result<Vec<u8>> {
        let read = transfer_exact(self.link.as_mut(), 0, request, reports, TRANSACTION_TIMEOUT)?
            .ok_or_else(|| {
                anyhow!(
                    "no answer to command 0x{request_cmd:02x} within {:?}",
                    TRANSACTION_TIMEOUT
                )
            })?;
        let mut stream = Vec::with_capacity(reports * WIRE_REPORT_BYTES);
        for report in &read {
            stream.extend_from_slice(&protocol_report(report)?);
        }
        let frame = parse_frame(&stream, request_cmd)?;
        if response_report_count(frame.payload.len()) != reports {
            bail!(
                "command 0x{request_cmd:02x}: payload {} bytes implies {} reports, read {reports}",
                frame.payload.len(),
                response_report_count(frame.payload.len())
            );
        }
        Ok(frame.payload.to_vec())
    }

    // ── Commands (all read-only) ────────────────────────────────────────

    /// Sync / device info (cmd 0x01). Returns the parsed 60-byte response.
    pub fn sync(&mut self) -> Result<SyncInfo> {
        self.guard(|s| {
            let payload = s.transact(&sync_request(), CMD_SYNC, 1)?;
            decode_sync(&payload)
        })
    }

    /// Board id shortcut for [`sync`].
    pub fn board_id(&mut self) -> Result<u32> {
        self.sync().map(|s| s.board_id)
    }

    /// Travel scale via cmd 0x00 order 0x25.
    pub fn scale(&mut self) -> Result<TravelScale> {
        self.guard(|s| {
            let payload = s.transact(&scale_request(), CMD_API, 1)?;
            decode_scale(&payload)
        })
    }

    /// Full default physical map: reads (0,1), (2,3), (4,5) → 6×21 usages.
    pub fn default_map(&mut self) -> Result<KeyMap> {
        self.guard(|s| {
            let mut map = [[0u8; COLS]; ROWS];
            for first in (0..ROWS as u8).step_by(2) {
                let second = first + 1;
                let payload =
                    s.transact(&default_map_request(first, second), CMD_DEFAULT_KEYS, 1)?;
                decode_default_map_rows(&payload, first, second, &mut map)?;
            }
            Ok(map)
        })
    }

    /// Factory key bytes (nonzero default-map usages) in row-major order.
    fn factory_keys(map: &KeyMap) -> Result<Vec<u8>> {
        let mut keys = Vec::new();
        let mut seen = [false; 256];
        for row in map.iter() {
            for &key in row.iter() {
                if key == 0 {
                    continue;
                }
                if seen[key as usize] {
                    bail!("default map: factory key 0x{key:02x} appears more than once");
                }
                seen[key as usize] = true;
                keys.push(key);
            }
        }
        if keys.is_empty() {
            bail!("default map: no populated positions");
        }
        Ok(keys)
    }

    /// Build one padded query batch covering `keys[begin..]`.
    fn make_query(keys: &[u8], begin: usize) -> KeyFunctionQuery {
        let count = (keys.len() - begin).min(KEY_FUNCTION_RECORDS);
        let mut query = KeyFunctionQuery {
            keys: [0u8; KEY_FUNCTION_RECORDS],
            count,
        };
        for i in 0..KEY_FUNCTION_RECORDS {
            // Pad the short final batch by repeating its last real key.
            query.keys[i] = keys[begin + i.min(count - 1)];
        }
        query
    }

    /// One complete active Fn0 map generation (all 0x23 batches).
    pub fn active_map(&mut self, default_map: &KeyMap) -> Result<ActiveMap> {
        self.guard(|s| {
            let keys = Self::factory_keys(default_map)?;
            let mut functions = [[0u16; COLS]; ROWS];
            for begin in (0..keys.len()).step_by(KEY_FUNCTION_RECORDS) {
                let query = Self::make_query(&keys, begin);
                let payload = s.transact(&key_function_request(&query), CMD_KEY_FUNCTIONS, 1)?;
                let records = decode_key_function_response(&payload, &query)?;
                apply_key_function_batch(default_map, &records, &mut functions)?;
            }
            let mut map = ActiveMap {
                functions,
                keys: [[None; COLS]; ROWS],
            };
            for (r, row) in map.keys.iter_mut().enumerate() {
                for (c, cell) in row.iter_mut().enumerate() {
                    if default_map[r][c] != 0 {
                        *cell = decode_key_function(functions[r][c]);
                    }
                }
            }
            Ok(map)
        })
    }

    /// Live travel: both halves merged into the 6×21 matrix (µm).
    pub fn travel(&mut self) -> Result<TravelMatrix> {
        self.guard(|s| {
            let mut halves = Vec::with_capacity(2);
            for half in 1..=2u8 {
                let payload =
                    s.transact(&travel_request(half), CMD_MATRIX, MAX_RESPONSE_REPORTS)?;
                halves.push(decode_travel_half(&payload)?);
            }
            let first: TravelHalf = halves[0];
            let second: TravelHalf = halves[1];
            Ok(merge_travel_halves(&first, &second))
        })
    }

    /// Status matrix (cmd 0x12 sel 0x03). Optional; unused in steady state.
    pub fn status(&mut self) -> Result<[[u8; COLS]; ROWS]> {
        self.guard(|s| {
            let payload = s.transact(&status_request(), CMD_MATRIX, MAX_RESPONSE_REPORTS)?;
            decode_status(&payload)
        })
    }

    /// Structural admission proof (spec §5). `expected_board` is the table
    /// board id for the device's VID:PID ([`known_board_id`]); pass `None`
    /// for unknown devices — the proof then validates structure only and
    /// `Admission::exact_known_board` stays false.
    ///
    /// Gates, in order: sync board match (when expected), scale plausibility,
    /// default-map uniqueness (≥2 populated keys), two byte-identical active
    /// Fn0 generations, travel within `max + max(8*precision, 200)` µm at
    /// populated positions.
    pub fn prove_identity(&mut self, expected_board: Option<u32>) -> Result<Admission> {
        self.guard(|s| {
            let sync = s.sync()?;
            if let Some(expected) = expected_board {
                if sync.board_id != expected {
                    bail!(
                        "board id 0x{:08x} does not match expected 0x{expected:08x}",
                        sync.board_id
                    );
                }
            }
            let scale = s.scale()?;
            let default_map = s.default_map()?;
            Self::check_default_map(&default_map)?;

            let first = s.active_map(&default_map)?;
            let second = s.active_map(&default_map)?;
            if first.functions != second.functions {
                bail!("active Fn0 map is not stable across two generations");
            }
            let active_map = second;

            let travel = s.travel()?;
            Self::check_travel_plausible(&travel, &default_map, &scale)?;

            Ok(Admission {
                board_id: sync.board_id,
                exact_known_board: expected_board.is_some(),
                sync,
                scale,
                default_map,
                active_map,
                travel,
            })
        })
    }

    /// Spec §5 gate 4: ≥2 non-zero keys, all unique, inside the 6×21 matrix.
    fn check_default_map(map: &KeyMap) -> Result<()> {
        let mut seen = [false; 256];
        let mut populated = 0usize;
        for row in map.iter() {
            for &key in row.iter() {
                if key == 0 {
                    continue;
                }
                if seen[key as usize] {
                    bail!("default map: factory key 0x{key:02x} appears more than once");
                }
                seen[key as usize] = true;
                populated += 1;
            }
        }
        if populated < 2 {
            bail!("default map: only {populated} populated positions, need at least 2");
        }
        Ok(())
    }

    /// Spec §5 gate 6: every populated position ≤ max + max(8*precision, 200).
    fn check_travel_plausible(
        travel: &TravelMatrix,
        default_map: &KeyMap,
        scale: &TravelScale,
    ) -> Result<()> {
        let margin = (scale.precision_um as u32 * 8).max(200);
        let limit = scale.maximum_travel_um as u32 + margin;
        for (r, row) in default_map.iter().enumerate() {
            for (c, &key) in row.iter().enumerate() {
                if key == 0 {
                    continue;
                }
                if travel.samples_um[r][c] as u32 > limit {
                    bail!(
                        "travel implausible at ({r},{c}): {} µm > limit {limit} µm",
                        travel.samples_um[r][c]
                    );
                }
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;

    // ── Scripted link ───────────────────────────────────────────────────

    /// A link that answers reads from a queue of raw wire reports
    /// (65-byte Win32 envelopes). `read(ZERO)` always reports an empty
    /// queue, modelling a clean input buffer for the pre-request flush.
    struct ScriptedLink {
        responses: VecDeque<Vec<u8>>,
        written: Vec<Vec<u8>>,
    }

    impl ScriptedLink {
        fn new() -> Self {
            Self {
                responses: VecDeque::new(),
                written: Vec::new(),
            }
        }
        fn push_frame(&mut self, frame: &[u8; WIRE_REPORT_BYTES]) {
            let mut wire = Vec::with_capacity(HID_ENVELOPE_BYTES);
            wire.push(0);
            wire.extend_from_slice(frame);
            self.responses.push_back(wire);
        }
        fn push_reports(&mut self, frames: &[[u8; WIRE_REPORT_BYTES]]) {
            for f in frames {
                self.push_frame(f);
            }
        }
    }

    impl Link for ScriptedLink {
        fn write(&mut self, report_id: u8, data: &[u8]) -> Result<()> {
            let mut wire = Vec::with_capacity(data.len() + 1);
            wire.push(report_id);
            wire.extend_from_slice(data);
            self.written.push(wire);
            Ok(())
        }
        fn read(&mut self, timeout: Duration) -> Result<Option<Vec<u8>>> {
            if timeout.is_zero() {
                return Ok(None);
            }
            Ok(self.responses.pop_front())
        }
    }

    /// Test-side frame builder (same checksum formula, kept independent of
    /// `build_frame` so a shared bug cannot hide).
    fn test_frame(command: u8, payload: &[u8]) -> [u8; WIRE_REPORT_BYTES] {
        let mut f = [0u8; WIRE_REPORT_BYTES];
        f[0] = FRAME_HEAD;
        f[1] = payload.len() as u8;
        f[2] = command;
        let mut sum = 0x35u16 + 0x5Cu16 + payload.len() as u16 + command as u16;
        if !payload.is_empty() {
            sum += payload[payload.len() - 1] as u16;
        }
        f[3] = (sum & 0xFF) as u8;
        f[4..4 + payload.len()].copy_from_slice(payload);
        f
    }

    /// Multi-report variant of [`test_frame`]: the logical frame
    /// (`4 + payload.len()` bytes) zero-padded to whole 64-byte reports.
    fn test_frame_stream(command: u8, payload: &[u8]) -> Vec<u8> {
        assert!(payload.len() <= 0xFF);
        let mut s = Vec::with_capacity(4 + payload.len());
        s.push(FRAME_HEAD);
        s.push(payload.len() as u8);
        s.push(command);
        let mut sum = 0x35u16 + 0x5Cu16 + payload.len() as u16 + command as u16;
        if !payload.is_empty() {
            sum += payload[payload.len() - 1] as u16;
        }
        s.push((sum & 0xFF) as u8);
        s.extend_from_slice(payload);
        s.resize(s.len().div_ceil(WIRE_REPORT_BYTES) * WIRE_REPORT_BYTES, 0);
        s
    }

    /// Split a byte stream into zero-padded 64-byte protocol reports.
    fn stream_to_reports(stream: &[u8]) -> Vec<[u8; WIRE_REPORT_BYTES]> {
        stream
            .chunks(WIRE_REPORT_BYTES)
            .map(|chunk| {
                let mut r = [0u8; WIRE_REPORT_BYTES];
                r[..chunk.len()].copy_from_slice(chunk);
                r
            })
            .collect()
    }

    // ── Fixtures ────────────────────────────────────────────────────────

    /// Realistic sync payload: board 0x16052201 (V75), "App V1.0.8".
    fn sync_payload(board: u32) -> Vec<u8> {
        let mut p = vec![0u8; SYNC_PAYLOAD];
        p[1..5].copy_from_slice(&board.to_le_bytes());
        p[5..8].copy_from_slice(&[0x00, 0x04, 0x00]); // V75 platform bytes
        p[8] = 0x10;
        p[9..25].copy_from_slice(b"SN-V75-00012345\0");
        p[25] = 0x10;
        p[26..42].copy_from_slice(b"App V1.0.8\0\0\0\0\0\0");
        p[42] = 0x10;
        p[43..59].copy_from_slice(b"Feb  4 2026\0\0\0\0\0");
        p[59] = 0xFF;
        p
    }

    fn scale_payload(precision: u8, min: u16, max: u16) -> Vec<u8> {
        let mut p = vec![0u8, ORDER_PRECISION, precision, 0, 0, 0, 0];
        p[3..5].copy_from_slice(&min.to_le_bytes());
        p[5..7].copy_from_slice(&max.to_le_bytes());
        p
    }

    /// Default-map response payload for rows (first, second) of `map`.
    fn default_map_payload(map: &KeyMap, first: u8, second: u8) -> Vec<u8> {
        let mut p = vec![0u8; DEFAULT_MAP_PAYLOAD];
        p[1] = first;
        p[2..2 + COLS].copy_from_slice(&map[first as usize]);
        p[24..24 + COLS].copy_from_slice(&map[second as usize]);
        p[23] = second;
        p
    }

    /// Key-function response payload echoing `query` with `func(i)` per record.
    fn keyfunc_payload(query: &KeyFunctionQuery, func: impl Fn(usize) -> u16) -> Vec<u8> {
        let mut p = vec![0u8; KEY_FUNCTION_PAYLOAD];
        for i in 0..KEY_FUNCTION_RECORDS {
            let off = 1 + i * 4;
            p[off] = query.keys[i];
            p[off + 1] = LAYOUT_FN0;
            p[off + 2..off + 4].copy_from_slice(&func(i).to_le_bytes());
        }
        p
    }

    /// A small realistic default map: rows 1-2 populated like a 60% keyboard.
    fn test_default_map() -> KeyMap {
        let mut map = [[0u8; COLS]; ROWS];
        let row1 = [
            0x29, 0x1e, 0x1f, 0x20, 0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x2d, 0x2e, 0x2a, 0,
            0, 0, 0, 0, 0, 0,
        ];
        let row2 = [
            0x2b, 0x14, 0x1a, 0x08, 0x15, 0x17, 0x1c, 0x18, 0x0c, 0x12, 0x13, 0x2f, 0x30, 0x31, 0,
            0, 0, 0, 0, 0, 0,
        ];
        map[1] = row1;
        map[2] = row2;
        map
    }

    fn test_travel_payload(_half: u8, fill: u16) -> Vec<u8> {
        // Response carries no half echo: p[0]=0, p[1]=0x02, then 63 u16.
        let mut p = vec![0u8; TRAVEL_PAYLOAD];
        p[1] = SELECTOR_TRAVEL;
        for i in 0..TRAVEL_VALUES_PER_HALF {
            p[2 + 2 * i..4 + 2 * i].copy_from_slice(&fill.to_le_bytes());
        }
        p
    }

    /// Queue the full 17-transaction proof exchange on `link`.
    fn queue_proof(link: &mut ScriptedLink, map: &KeyMap, opts: &ProofOpts) {
        // sync
        let board = opts.board.unwrap_or(0x1605_2201);
        link.push_frame(&test_frame(CMD_SYNC | 0x80, &sync_payload(board)));
        // scale
        link.push_frame(&test_frame(
            CMD_API | 0x80,
            &scale_payload(5, 5, opts.max_um),
        ));
        // default map ×3
        for first in (0..ROWS as u8).step_by(2) {
            let payload = default_map_payload(map, first, first + 1);
            link.push_frame(&test_frame(CMD_DEFAULT_KEYS | 0x80, &payload));
        }
        // two active-map generations (skipped entirely when the default map
        // is too broken to enumerate keys — the proof fails earlier anyway)
        let Ok(keys) = SparkPlayJoy::factory_keys(map) else {
            return;
        };
        for _gen in 0..2 {
            for begin in (0..keys.len()).step_by(KEY_FUNCTION_RECORDS) {
                let query = SparkPlayJoy::make_query(&keys, begin);
                let func = |i: usize| -> u16 {
                    let k = query.keys[i];
                    if opts.unstable && _gen == 1 && i == 0 {
                        return 0x9999; // second generation differs
                    }
                    match k {
                        0x1e => 0xf001, // Esc position → Fn marker
                        0x29 => 0xe7,
                        _ => 0x04 + (k as u16 % 0xe0),
                    }
                };
                let payload = keyfunc_payload(&query, func);
                link.push_frame(&test_frame(CMD_KEY_FUNCTIONS | 0x80, &payload));
            }
        }
        // travel halves (3 reports each)
        for half in 1..=2u8 {
            let payload = test_travel_payload(half, opts.travel_um);
            let stream = test_frame_stream(CMD_MATRIX | 0x80, &payload);
            assert_eq!(stream.len(), 3 * WIRE_REPORT_BYTES);
            link.push_reports(&stream_to_reports(&stream));
        }
    }

    struct ProofOpts {
        board: Option<u32>,
        max_um: u16,
        travel_um: u16,
        unstable: bool,
    }

    impl Default for ProofOpts {
        fn default() -> Self {
            Self {
                board: None,
                max_um: 3500,
                travel_um: 100,
                unstable: false,
            }
        }
    }

    fn proof_client() -> SparkPlayJoy {
        let mut link = ScriptedLink::new();
        let map = test_default_map();
        queue_proof(&mut link, &map, &ProofOpts::default());
        SparkPlayJoy::new(Box::new(link))
    }

    // ── Frame / checksum tests ──────────────────────────────────────────

    #[test]
    fn checksum_matches_captured_vector() {
        // Verified byte-for-byte: travel half-1 request is
        // `5C 04 12 A6 02 01 FF FF` (docs §2.5).
        let frame = travel_request(1);
        assert_eq!(
            &frame[..8],
            &[0x5C, 0x04, 0x12, 0xA6, 0x02, 0x01, 0xFF, 0xFF]
        );
        assert_eq!(
            checksum(4, CMD_MATRIX, &[SELECTOR_TRAVEL, 1, 0xFF, 0xFF]),
            0xA6
        );
        assert_eq!(
            checksum(6, CMD_SYNC, &[0x01, 0x02, 0x03, 0x04, 0xFF, 0xFF]),
            sync_request()[3]
        );
    }

    #[test]
    fn checksum_omits_last_payload_term_when_empty() {
        // len==0: cs = 0x35+0x5C+0+cmd only.
        let f = build_frame(0x01, &[]).unwrap();
        assert_eq!(f[1], 0);
        assert_eq!(f[3], (0x35 + 0x5C + 0x01) as u8);
        // len==0 checksum omits the last-payload term: differs from the
        // same command with a non-empty payload.
        assert_ne!(f[3], checksum(1, 0x01, &[0x00]));
    }

    #[test]
    fn build_frame_zero_pads_and_rejects_oversize() {
        let f = build_frame(CMD_SYNC, &[1, 2, 3]).unwrap();
        assert_eq!(f[4], 1);
        assert_eq!(f[61], 0);
        assert!(build_frame(CMD_SYNC, &[0u8; 61]).is_none());
        assert!(build_frame(CMD_SYNC, &[0u8; 60]).is_some());
    }

    #[test]
    fn parse_frame_single_report() {
        let payload = sync_payload(0x1605_2201);
        let frame = test_frame(CMD_SYNC | 0x80, &payload);
        let view = parse_frame(&frame, CMD_SYNC).unwrap();
        assert_eq!(view.command, CMD_SYNC | 0x80);
        assert_eq!(view.payload.len(), SYNC_PAYLOAD);
        assert_eq!(view.payload[1..5], 0x1605_2201u32.to_le_bytes());
    }

    #[test]
    fn parse_frame_three_report_continuation() {
        // Travel response: 132-byte frame inside a 192-byte stream.
        let payload = test_travel_payload(1, 42);
        let stream = test_frame_stream(CMD_MATRIX | 0x80, &payload);
        assert_eq!(stream.len(), 192);
        let view = parse_frame(&stream, CMD_MATRIX).unwrap();
        assert_eq!(view.payload.len(), TRAVEL_PAYLOAD);
        assert_eq!(view.payload[0], 0);
        assert_eq!(view.payload[1], SELECTOR_TRAVEL);
        assert_eq!(rd16le(view.payload, 2), 42);
        // Truncated stream must fail.
        assert!(parse_frame(&stream[..100], CMD_MATRIX).is_err());
        // Wrong request command must fail.
        assert!(parse_frame(&stream, CMD_SYNC).is_err());
    }

    #[test]
    fn protocol_report_strips_win32_envelope() {
        let mut wire = vec![0u8; HID_ENVELOPE_BYTES];
        wire[1] = FRAME_HEAD;
        let r = protocol_report(&wire).unwrap();
        assert_eq!(r[0], FRAME_HEAD);
        // Non-zero report id is an anomaly.
        wire[0] = 1;
        assert!(protocol_report(&wire).is_err());
        // Bare 64-byte report also accepted.
        let bare = [0u8; WIRE_REPORT_BYTES];
        assert!(protocol_report(&bare).is_ok());
        assert!(protocol_report(&[0u8; 10]).is_err());
    }

    #[test]
    fn response_report_count_boundaries() {
        assert_eq!(response_report_count(60), 1); // 64-byte frame
        assert_eq!(response_report_count(61), 2);
        assert_eq!(response_report_count(124), 2);
        assert_eq!(response_report_count(125), 3);
        assert_eq!(response_report_count(128), 3);
        assert_eq!(response_report_count(130), 3);
    }

    // ── Decoder tests ───────────────────────────────────────────────────

    #[test]
    fn decode_sync_extracts_board_and_descriptors() {
        let info = decode_sync(&sync_payload(0x2e02_2201)).unwrap();
        assert_eq!(info.board_id, 0x2e02_2201);
        assert_eq!(info.platform, [0x00, 0x04, 0x00]);
        assert_eq!(info.app_version, "App V1.0.8");
        assert_eq!(info.build_label, "Feb  4 ");
        assert!(info.serial.starts_with("SN-V75"));
    }

    #[test]
    fn decode_sync_rejects_bad_structure() {
        let mut p = sync_payload(0x1605_2201);
        p[59] = 0x00; // trailer
        assert!(decode_sync(&p).is_err());
        let mut p = sync_payload(0x1605_2201);
        p[26] = b'X'; // "Xpp V…" loses the "App V" prefix
        assert!(decode_sync(&p).is_err());
        let p = sync_payload(0);
        assert!(decode_sync(&p).is_err()); // zero board
        let mut p = sync_payload(0x1605_2201);
        p[43] = 0x01; // non-printable inside build descriptor
        assert!(decode_sync(&p).is_err());
    }

    #[test]
    fn decode_scale_bounds() {
        let s = decode_scale(&scale_payload(5, 5, 3500)).unwrap();
        assert_eq!(
            s,
            TravelScale {
                precision_um: 5,
                minimum_travel_um: 5,
                maximum_travel_um: 3500
            }
        );
        assert!(decode_scale(&scale_payload(0, 5, 3500)).is_err()); // precision < 1
        assert!(decode_scale(&scale_payload(101, 5, 3500)).is_err());
        assert!(decode_scale(&scale_payload(5, 4000, 3500)).is_err()); // min > max
        assert!(decode_scale(&scale_payload(5, 5, 499)).is_err()); // max < 500
    }

    #[test]
    fn decode_default_map_rows_checks_echoes() {
        let map = test_default_map();
        let mut out = [[0u8; COLS]; ROWS];
        let payload = default_map_payload(&map, 0, 1);
        decode_default_map_rows(&payload, 0, 1, &mut out).unwrap();
        assert_eq!(out[0], map[0]);
        assert_eq!(out[1], map[1]);
        // Echo mismatch rejected.
        let mut bad = payload.clone();
        bad[23] = 2;
        assert!(decode_default_map_rows(&bad, 0, 1, &mut out).is_err());
        // Same row twice rejected.
        assert!(decode_default_map_rows(&payload, 1, 1, &mut out).is_err());
    }

    #[test]
    fn key_function_echo_and_duplicate_correlation() {
        let keys = SparkPlayJoy::factory_keys(&test_default_map()).unwrap();
        let query = SparkPlayJoy::make_query(&keys, 0);
        let payload = keyfunc_payload(&query, |i| if i == 0 { 0xf001 } else { 0x04 + i as u16 });
        let records = decode_key_function_response(&payload, &query).unwrap();
        assert_eq!(records[0].function, 0xf001);
        assert_eq!(records[0].key, query.keys[0]);

        // Wrong echo → error.
        let mut bad = payload.clone();
        bad[1] = 0x77;
        assert!(decode_key_function_response(&bad, &query).is_err());

        // Duplicate padded key with inconsistent function → error.
        // Build a short query whose tail is all padding of the last real key.
        let mut short = KeyFunctionQuery {
            keys: [0; KEY_FUNCTION_RECORDS],
            count: 2,
        };
        short.keys[0] = keys[0];
        short.keys[1] = keys[1];
        for i in 2..KEY_FUNCTION_RECORDS {
            short.keys[i] = keys[1]; // pad repeats last real key
        }
        let mut p = keyfunc_payload(&short, |_| 0x0028);
        // Make the two echoes of key[1] disagree.
        let off = 1 + (KEY_FUNCTION_RECORDS - 1) * 4;
        p[off + 2] = 0x99;
        p[off + 3] = 0x00;
        assert!(decode_key_function_response(&p, &short).is_err());
    }

    #[test]
    fn decode_key_function_publishable_filter() {
        assert_eq!(
            decode_key_function(0x0004),
            Some(KeyFunction::HidUsage(0x04))
        );
        assert_eq!(
            decode_key_function(0x00e7),
            Some(KeyFunction::HidUsage(0xe7))
        );
        assert_eq!(decode_key_function(0xf001), Some(KeyFunction::Fn));
        assert_eq!(decode_key_function(0x0000), None);
        assert_eq!(decode_key_function(0x0003), None);
        assert_eq!(decode_key_function(0x00e8), None);
        assert_eq!(decode_key_function(0xf002), None);
        assert_eq!(decode_key_function(0xffff), None);
    }

    #[test]
    fn decode_travel_and_status() {
        let half = decode_travel_half(&test_travel_payload(2, 0x1234)).unwrap();
        assert_eq!(half[0][0], 0x1234);
        assert_eq!(half[2][20], 0x1234);
        assert!(decode_travel_half(&test_travel_payload(2, 0)[..100]).is_err());

        let mut sp = vec![0u8; STATUS_PAYLOAD];
        sp[0] = 0;
        sp[1] = SELECTOR_STATUS;
        for i in 0..MATRIX_POSITIONS {
            sp[2 + i] = (i % 251) as u8;
        }
        sp[STATUS_PAYLOAD - 2] = 0xFF;
        sp[STATUS_PAYLOAD - 1] = 0xFF;
        let status = decode_status(&sp).unwrap();
        assert_eq!(status[5][20], (5 * COLS + 20) as u8 % 251);
        let mut short = sp.clone();
        short.pop();
        assert!(decode_status(&short).is_err());
    }

    #[test]
    fn merge_and_normalize_travel() {
        let mut first = [[0u16; COLS]; ROWS_PER_TRAVEL_HALF];
        let mut second = [[0u16; COLS]; ROWS_PER_TRAVEL_HALF];
        first[0][0] = 100;
        second[2][20] = 200;
        let m = merge_travel_halves(&first, &second);
        assert_eq!(m.samples_um[0][0], 100);
        assert_eq!(m.samples_um[5][20], 200);
        assert_eq!(m.samples_um[3][0], 0);
        assert_eq!(normalize_travel_to_milli(0, 3500), 0);
        assert_eq!(normalize_travel_to_milli(3500, 3500), 1000);
        assert_eq!(normalize_travel_to_milli(4000, 3500), 1000);
        assert_eq!(normalize_travel_to_milli(1750, 3500), 500);
        assert_eq!(normalize_travel_to_milli(100, 0), 0);
    }

    // ── Session / admission tests ───────────────────────────────────────

    #[test]
    fn sync_roundtrip_over_link() {
        let mut link = ScriptedLink::new();
        link.push_frame(&test_frame(CMD_SYNC | 0x80, &sync_payload(0x1605_2201)));
        let mut dev = SparkPlayJoy::new(Box::new(link));
        let info = dev.sync().unwrap();
        assert_eq!(info.board_id, 0x1605_2201);
        assert!(!dev.is_poisoned());
    }

    #[test]
    fn prove_identity_full_pass() {
        let mut dev = proof_client();
        let admission = dev.prove_identity(Some(0x1605_2201)).unwrap();
        assert!(admission.exact_known_board);
        assert_eq!(admission.board_id, 0x1605_2201);
        assert_eq!(admission.scale.maximum_travel_um, 3500);
        // Fn marker survives as KeyFunction::Fn, not truncated.
        assert!(admission
            .active_map
            .keys
            .iter()
            .flatten()
            .any(|k| *k == Some(KeyFunction::Fn)));
        assert_eq!(admission.travel.samples_um[0][0], 100);
    }

    #[test]
    fn prove_identity_structural_only_for_unknown_board() {
        let mut link = ScriptedLink::new();
        let map = test_default_map();
        queue_proof(
            &mut link,
            &map,
            &ProofOpts {
                board: Some(0xdead_beef),
                ..Default::default()
            },
        );
        let mut dev = SparkPlayJoy::new(Box::new(link));
        // Unknown device: no expected board → structural proof only.
        let admission = dev.prove_identity(None).unwrap();
        assert!(!admission.exact_known_board);
        assert_eq!(admission.board_id, 0xdead_beef);
    }

    #[test]
    fn prove_identity_rejects_board_mismatch() {
        let mut link = ScriptedLink::new();
        let map = test_default_map();
        queue_proof(&mut link, &map, &ProofOpts::default());
        let mut dev = SparkPlayJoy::new(Box::new(link));
        let err = dev.prove_identity(Some(0x1605_2202)).unwrap_err();
        assert!(err.to_string().contains("board id"));
        assert!(dev.is_poisoned());
    }

    #[test]
    fn prove_identity_rejects_unstable_active_map() {
        let mut link = ScriptedLink::new();
        let map = test_default_map();
        queue_proof(
            &mut link,
            &map,
            &ProofOpts {
                unstable: true,
                ..Default::default()
            },
        );
        let mut dev = SparkPlayJoy::new(Box::new(link));
        let err = dev.prove_identity(Some(0x1605_2201)).unwrap_err();
        assert!(err.to_string().contains("not stable"));
    }

    #[test]
    fn prove_identity_rejects_implausible_travel() {
        let mut link = ScriptedLink::new();
        let map = test_default_map();
        // margin = max(8*5, 200) = 200 → limit 3700; 4000 exceeds it.
        queue_proof(
            &mut link,
            &map,
            &ProofOpts {
                travel_um: 4000,
                ..Default::default()
            },
        );
        let mut dev = SparkPlayJoy::new(Box::new(link));
        let err = dev.prove_identity(Some(0x1605_2201)).unwrap_err();
        assert!(err.to_string().contains("implausible"));
    }

    #[test]
    fn prove_identity_rejects_duplicate_default_key() {
        let mut link = ScriptedLink::new();
        let mut map = test_default_map();
        map[3][0] = map[1][0]; // duplicate factory key
        queue_proof(&mut link, &map, &ProofOpts::default());
        let mut dev = SparkPlayJoy::new(Box::new(link));
        let err = dev.prove_identity(Some(0x1605_2201)).unwrap_err();
        assert!(err.to_string().contains("more than once"));
    }

    #[test]
    fn no_answer_poisons_session() {
        let link = ScriptedLink::new(); // empty queue → reads return None
        let mut dev = SparkPlayJoy::new(Box::new(link));
        assert!(dev.sync().is_err());
        assert!(dev.is_poisoned());
        assert!(dev.scale().is_err()); // fast-fail on poisoned session
    }

    #[test]
    fn active_map_single_generation_and_decode() {
        let mut link = ScriptedLink::new();
        let map = test_default_map();
        let keys = SparkPlayJoy::factory_keys(&map).unwrap();
        for begin in (0..keys.len()).step_by(KEY_FUNCTION_RECORDS) {
            let query = SparkPlayJoy::make_query(&keys, begin);
            let payload = keyfunc_payload(&query, |i| match query.keys[i] {
                0x1e => 0xf001,
                _ => 0x28,
            });
            link.push_frame(&test_frame(CMD_KEY_FUNCTIONS | 0x80, &payload));
        }
        let mut dev = SparkPlayJoy::new(Box::new(link));
        let active = dev.active_map(&map).unwrap();
        // Row 1 col 0 is key 0x29 → 0x28 usage; Esc position (row1 col0 is
        // actually 0x29; find the 0x1e key).
        let mut saw_fn = false;
        let mut saw_usage = false;
        for r in 0..ROWS {
            for c in 0..COLS {
                if let Some(k) = active.keys[r][c] {
                    match k {
                        KeyFunction::Fn => saw_fn = true,
                        KeyFunction::HidUsage(_) => saw_usage = true,
                    }
                }
            }
        }
        assert!(saw_fn && saw_usage);
        assert!(!dev.is_poisoned());
    }

    #[test]
    fn known_identity_table() {
        assert_eq!(known_board_id(0x1ca5, 0x2201), Some(0x1605_2201));
        assert_eq!(known_board_id(0x1ca5, 0x2202), Some(0x1605_2202));
        assert_eq!(known_board_id(0x1ca2, 0x2201), Some(0x2e02_2201));
        assert_eq!(known_board_id(0x1ca2, 0x1902), None); // Aula, not in table
        assert!(SparkPlayJoy::matches(0xffa0, 1));
        assert!(!SparkPlayJoy::matches(0xffa0, 2));
        assert!(!SparkPlayJoy::matches(0xffb0, 1));
    }
}

#[cfg(test)]
mod prop_tests {
    use super::*;
    use proptest::prelude::*;

    proptest! {
        /// build_frame→parse_frame roundtrip: a response frame built for
        /// `request | 0x80` parses back to the identical payload.
        #[test]
        fn frame_roundtrip(
            request_cmd in any::<u8>(),
            payload in prop::collection::vec(any::<u8>(), 0..=60),
        ) {
            let response_cmd = request_cmd | 0x80;
            let frame = build_frame(response_cmd, &payload).expect("payload <= 60 always builds");
            let mut stream = Vec::with_capacity(WIRE_REPORT_BYTES);
            stream.extend_from_slice(&frame);
            let view = parse_frame(&stream, request_cmd).expect("self-built frame must parse");
            prop_assert_eq!(view.command, response_cmd);
            prop_assert_eq!(view.payload, &payload[..]);
        }

        /// Payloads over 60 bytes are refused by build_frame.
        #[test]
        fn build_frame_rejects_oversize(payload in prop::collection::vec(any::<u8>(), 61..=300)) {
            prop_assert!(build_frame(0x01, &payload).is_none());
        }

        /// The frame parser is total: arbitrary bytes of any length and
        /// any expected command produce Ok or Err, never a panic.
        #[test]
        fn parse_frame_never_panics(
            stream in prop::collection::vec(any::<u8>(), 0..=256),
            request_cmd in any::<u8>(),
        ) {
            let _ = parse_frame(&stream, request_cmd);
        }

        /// The Win32 envelope stripper is total on arbitrary reports.
        #[test]
        fn protocol_report_never_panics(report in prop::collection::vec(any::<u8>(), 0..=128)) {
            let _ = protocol_report(&report);
        }

        /// Key-function decode follows the documented ranges exactly.
        #[test]
        fn decode_key_function_ranges(function in any::<u16>()) {
            match decode_key_function(function) {
                Some(KeyFunction::HidUsage(u)) => {
                    prop_assert!((0x04..=0xe7).contains(&u));
                    prop_assert_eq!(u16::from(u), function);
                }
                Some(KeyFunction::Fn) => prop_assert_eq!(function, 0xf001),
                None => prop_assert!(!(0x04..=0xe7).contains(&function) && function != 0xf001),
            }
        }

        /// Travel normalisation is bounded and saturates at the maximum.
        #[test]
        fn normalize_travel_bounds(travel in any::<u16>(), max in any::<u16>()) {
            let v = normalize_travel_to_milli(travel, max);
            prop_assert!(v <= 1000);
            if travel == 0 || max == 0 {
                prop_assert_eq!(v, 0);
            } else if travel >= max {
                prop_assert_eq!(v, 1000);
            }
        }

        /// Every payload decoder is total on arbitrary bytes of arbitrary
        /// length: wrong lengths and malformed contents yield Err, never
        /// a panic. Exact-length payloads are generated separately so the
        /// in-bounds indexing paths are fuzzed too.
        #[test]
        fn payload_decoders_never_panics(
            data in prop::collection::vec(any::<u8>(), 0..=200),
            sync in prop::collection::vec(any::<u8>(), SYNC_PAYLOAD..=SYNC_PAYLOAD),
            scale in prop::collection::vec(any::<u8>(), SCALE_PAYLOAD..=SCALE_PAYLOAD),
            travel in prop::collection::vec(any::<u8>(), TRAVEL_PAYLOAD..=TRAVEL_PAYLOAD),
            status in prop::collection::vec(any::<u8>(), STATUS_PAYLOAD..=STATUS_PAYLOAD),
            dmap in prop::collection::vec(any::<u8>(), DEFAULT_MAP_PAYLOAD..=DEFAULT_MAP_PAYLOAD),
        ) {
            let _ = decode_sync(&data);
            let _ = decode_sync(&sync);
            let _ = decode_scale(&data);
            let _ = decode_scale(&scale);
            let _ = decode_travel_half(&data);
            let _ = decode_travel_half(&travel);
            let _ = decode_status(&data);
            let _ = decode_status(&status);
            let mut map = [[0u8; COLS]; ROWS];
            let _ = decode_default_map_rows(&data, 0, 1, &mut map);
            let _ = decode_default_map_rows(&dmap, 0, 1, &mut map);
            let _ = decode_default_map_rows(&dmap, 200, 201, &mut map);
        }

        /// The 0x23 decoder is total for arbitrary payloads and arbitrary
        /// (well-formed-count) queries.
        #[test]
        fn key_function_response_never_panics(
            data in prop::collection::vec(any::<u8>(), 0..=80),
            count in 1usize..=KEY_FUNCTION_RECORDS,
            keys in prop::collection::vec(any::<u8>(), KEY_FUNCTION_RECORDS..=KEY_FUNCTION_RECORDS),
        ) {
            let mut qk = [0u8; KEY_FUNCTION_RECORDS];
            qk.copy_from_slice(&keys[..KEY_FUNCTION_RECORDS]);
            let query = KeyFunctionQuery { keys: qk, count };
            let _ = decode_key_function_response(&data, &query);
        }
    }
}
