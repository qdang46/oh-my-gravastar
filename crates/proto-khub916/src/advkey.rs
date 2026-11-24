//! khub916 advanced keys — SOCD / MT (mod-tap) / TGL configuration.
//!
//! Port of the vendor `Ht`/`zt` engine paths `getKeyboardAdvancedKey`,
//! `setKeyboardSocdKey`, `setKeyboardMtKey`, `setKeyboardTglKey`,
//! `processHistory`, `calculateBaseAddress`/`calculateMtBaseAddress`/
//! `calculateTglBaseAddress` and `sendAdvanKeyHistory`
//! (`docs/research/khub-webapp/index-M8-m9qFR.deob.js`; spec:
//! `docs/protocol-khub916.md` §6/§7, schema notes `docs/advkeys-schema.md`).
//!
//! Wire layout (both transports):
//!
//! - **History blob, 512 B** = SOCD 200 B + MT 200 B + TGL 112 B. Each
//!   kind is a table of fixed-size slots (SOCD/MT 8 B = two u32 BE key
//!   values, TGL 4 B = one u32). The vendor finds the first all-zero slot
//!   (`processHistory`) or appends; there is no delete command — the
//!   vendor UI "delete" only edits a localStorage cache and never talks
//!   to the device.
//! - **Keymap bindings** (read via `key_values(0)` — cmd 131 arg 0,
//!   tags 248/1, the vendor `getKeyboardKeys({layer:0})`): a physical
//!   key's u32
//!   value is rewritten to `base + params` where `base` encodes the
//!   history slot: `0x20SS0000` (SOCD), `0x21SS0000` (MT),
//!   `0x22SS0000` (TGL), `SS` = slot index = (nonzero-group count − 1).
//!   SOCD adds `direction` (0–3) to key A and `256 + direction` to key B;
//!   MT adds `time` (hold time in 10 ms units, vendor slider 0–100); TGL
//!   adds nothing.
//! - **Wired transport**: read = cmd 146 `[146,0,0,1,0,0,2]`; write =
//!   cmd 18 `[18,0,0,1,0,0,2,…512 B]` fire-and-forget, verified by
//!   read-back. The keymap half of a set operation goes through
//!   [`Khub916::write_key_configuration`] — the vendor `sendKeyConfiguration`
//!   header `[3,0,0,1,0,0,2]` (note: *not* the `setKeyboardKeys` 248/1
//!   header used by `write_keymap`).
//! - **Wireless transport**: read = cmd 82, write = chunked cmd 18 (see
//!   [`crate::wireless`]); the keymap half uses the generic chunked
//!   cmd-1 write [`Khub916Wireless::write_key_configuration`]. Both are
//!   code-verified only — no wireless hardware was ever attached.
//!
//! Safety: cmd 18/82 are the vendor's adv-key history write/read — they
//! are *not* reset or firmware commands. The dangerous opcodes (17 reset,
//! wireless 6 factory reset) remain unimplemented.

use anyhow::{bail, Result};

use crate::{decode_key_value, KeyValue, WriteOutcome};

// ── Blob layout constants ────────────────────────────────────────────────

/// Total history blob size: 200 + 200 + 112.
pub const ADV_BLOB_BYTES: usize = 512;
/// SOCD region: blob[0..200], 8-byte slots (25 slots).
pub const SOCD_REGION_BYTES: usize = 200;
/// MT region: blob[200..400], 8-byte slots (25 slots).
pub const MT_REGION_BYTES: usize = 200;
/// TGL region: blob[400..512], 4-byte slots (28 slots).
pub const TGL_REGION_BYTES: usize = 112;
/// Slot size for SOCD and MT entries (two u32 key values).
pub const HISTORY_SLOT_BYTES: usize = 8;
/// Slot size for TGL entries (one u32 key value).
pub const TGL_SLOT_BYTES: usize = 4;

/// Keymap-value base addresses (`calculateBaseAddress` family). The low
/// 16 bits are free for parameters; bits 16..23 carry the slot index.
pub const SOCD_BASE: u32 = 0x2000_0000;
pub const MT_BASE: u32 = 0x2100_0000;
pub const TGL_BASE: u32 = 0x2200_0000;

/// Keymap type tags that mark macro/SOCD/MT/TGL references. The vendor
/// refuses to (re)bind a position whose current value carries one of
/// these tags.
pub const ADV_FORBIDDEN_TAGS: [u8; 4] = [0x03, 0x20, 0x21, 0x22];

/// Advanced-key kind.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AdvKind {
    Socd,
    Mt,
    Tgl,
}

impl AdvKind {
    pub fn name(self) -> &'static str {
        match self {
            AdvKind::Socd => "socd",
            AdvKind::Mt => "mt",
            AdvKind::Tgl => "tgl",
        }
    }

    fn region_range(self) -> (usize, usize) {
        match self {
            AdvKind::Socd => (0, SOCD_REGION_BYTES),
            AdvKind::Mt => (SOCD_REGION_BYTES, SOCD_REGION_BYTES + MT_REGION_BYTES),
            AdvKind::Tgl => (
                SOCD_REGION_BYTES + MT_REGION_BYTES,
                ADV_BLOB_BYTES,
            ),
        }
    }

    fn slot_bytes(self) -> usize {
        match self {
            AdvKind::Socd | AdvKind::Mt => HISTORY_SLOT_BYTES,
            AdvKind::Tgl => TGL_SLOT_BYTES,
        }
    }

}

/// Kind-specific low bits of an adv keymap binding value.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AdvDetail {
    /// SOCD: `direction` 0–3 (vendor socdList ids: 0 last-input priority,
    /// 1 absolute priority key A, 2 absolute priority key B, 3 all-cancel);
    /// `key_b` distinguishes the second bound position (value = base+256+dir).
    Socd { direction: u8, key_b: bool },
    /// MT: hold time in vendor units (10 ms each; UI slider 0–100).
    Mt { time: u16 },
    /// TGL carries no parameters.
    Tgl,
}

/// One keymap slot bound to an adv-key history entry.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AdvBinding {
    /// Keymap index (0-based); vendor `pos = 8 + index*4`.
    pub index: usize,
    /// Vendor position value (`8 + index*4`).
    pub pos: u32,
    /// Raw keymap u32.
    pub value: u32,
    pub kind: AdvKind,
    /// History slot index carried in bits 16..23 of the value.
    pub slot: u32,
    pub detail: AdvDetail,
}

/// One non-empty history slot decoded back to u32 key values.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HistoryEntry {
    pub kind: AdvKind,
    /// Slot index = byte offset / slot size within the kind's region.
    pub slot: usize,
    /// u32 BE values stored in the slot (SOCD: [keyA,keyB] originals,
    /// MT: [tap,hold], TGL: [toggle target]).
    pub values: Vec<u32>,
}

// ── Blob normalization / region access ───────────────────────────────────

/// Copy `blob` into a fixed 512-byte view, zero-padding a short read
/// (the device may trim trailing zeros; the vendor JS slices the raw
/// response without padding — padding is equivalent because the trimmed
/// bytes are always zero).
pub fn normalize_blob(blob: &[u8]) -> [u8; ADV_BLOB_BYTES] {
    let mut out = [0u8; ADV_BLOB_BYTES];
    let n = blob.len().min(ADV_BLOB_BYTES);
    out[..n].copy_from_slice(&blob[..n]);
    out
}

// ── Vendor algorithms (faithful ports) ───────────────────────────────────

/// Vendor `processHistory`: copy `region`, scan slots of `slot` bytes
/// from offset 0; the first all-zero slot receives `entry` (truncated to
/// the region bounds exactly like the JS `o+c < n.length` guard). If no
/// all-zero slot exists the entry is *appended* — callers must check
/// [`vendor_free_slot`] first so the region cannot outgrow its table.
fn process_history(region: &[u8], entry: &[u8], slot: usize) -> Result<Vec<u8>> {
    let mut n = region.to_vec();
    let mut placed = false;
    let mut o = 0usize;
    while o < n.len() && !placed {
        let end = (o + slot).min(n.len());
        if n[o..end].iter().all(|&b| b == 0) {
            for (c, &b) in entry.iter().enumerate() {
                if o + c < n.len() {
                    n[o + c] = b;
                }
            }
            placed = true;
        }
        o += slot;
    }
    if !placed {
        n.extend_from_slice(entry);
    }
    Ok(n)
}

/// Vendor free-slot pre-check: any run of 4 consecutive zero bytes in
/// the region (`m[y]===0 && m[y+1]===0 && m[y+2]===0 && m[y+3]===0`,
/// `y <= len-4`) — used for all three kinds regardless of slot size.
fn vendor_free_slot(region: &[u8]) -> bool {
    region.len() >= 4 && region.windows(4).any(|w| w == [0, 0, 0, 0])
}

/// Vendor `calculateBaseAddress`/`calculateMtBaseAddress`/
/// `calculateTglBaseAddress`: count non-zero `slot`-byte groups; base for
/// 0 or 1 groups, otherwise `base + (count-1)*0x10000`. Note the vendor
/// counts *non-zero groups*, not the highest index — bug-compatible port.
fn base_address(region: &[u8], slot: usize, base: u32) -> u32 {
    let nonzero = region
        .chunks(slot)
        .filter(|c| c.iter().any(|&b| b != 0))
        .count();
    if nonzero <= 1 {
        base
    } else {
        base + (nonzero as u32 - 1) * 0x1_0000
    }
}

/// Reject a keymap value whose type tag is macro/SOCD/MT/TGL (the vendor
/// `s=[3,32,33,34]` check before binding a position).
fn check_bindable(value: u32, what: &str) -> Result<()> {
    let tag = (value >> 24) as u8;
    if ADV_FORBIDDEN_TAGS.contains(&tag) {
        bail!(
            "{what}: keymap value 0x{value:08X} already carries a macro/adv-key tag — unbind it first"
        );
    }
    Ok(())
}

fn u32s_to_bytes(values: &[u32]) -> Vec<u8> {
    let mut out = Vec::with_capacity(values.len() * 4);
    for v in values {
        out.extend_from_slice(&v.to_be_bytes());
    }
    out
}

// ── Write planning (pure; unit-tested) ───────────────────────────────────

/// Result of planning an adv-key set: the full 512-byte history blob and
/// the full replacement keymap (same length as the input read).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AdvPlan {
    pub blob: [u8; ADV_BLOB_BYTES],
    pub keymap: Vec<u32>,
}

/// Shared tail of the three planners: validate indices, run
/// `processHistory` on the kind's region, compute the base address and
/// assemble the 512-byte blob (with the vendor's `tgl[110]=tgl[111]=0`
/// footer clear applied to every write).
fn plan(
    blob: &[u8],
    keymap: &[u32],
    kind: AdvKind,
    entry: &[u8],
    apply: impl FnOnce(u32 /*base*/, &mut Vec<u32>),
) -> Result<AdvPlan> {
    let mut b = normalize_blob(blob);
    // Vendor clears TGL region bytes 110/111 (= blob 510/511) on every
    // adv-key write, whatever kind is being set.
    b[ADV_BLOB_BYTES - 2] = 0;
    b[ADV_BLOB_BYTES - 1] = 0;

    let (rstart, rend) = kind.region_range();
    let region = &b[rstart..rend];
    if !vendor_free_slot(region) {
        bail!(
            "no available {} slot found. Maximum {} keys limit reached.",
            kind.name().to_uppercase(),
            kind.name().to_uppercase()
        );
    }
    let new_region = process_history(region, entry, kind.slot_bytes())?;
    if new_region.len() > kind.region_range().1 - kind.region_range().0 {
        bail!(
            "no available {} slot found (region overflow)",
            kind.name().to_uppercase()
        );
    }
    let base = base_address(&new_region, kind.slot_bytes(), kind_base(kind));

    let mut km = keymap.to_vec();
    apply(base, &mut km);

    // Reassemble: replace only the target region inside the normalized
    // blob (the other two regions are carried verbatim).
    b[rstart..rstart + new_region.len()].copy_from_slice(&new_region);
    // If the region shrank (never — process_history only grows or keeps
    // length) the tail would keep stale bytes; guard anyway.
    debug_assert_eq!(new_region.len(), rend - rstart);

    Ok(AdvPlan { blob: b, keymap: km })
}

fn kind_base(kind: AdvKind) -> u32 {
    match kind {
        AdvKind::Socd => SOCD_BASE,
        AdvKind::Mt => MT_BASE,
        AdvKind::Tgl => TGL_BASE,
    }
}

fn check_index(keymap: &[u32], index: usize, what: &str) -> Result<()> {
    if index >= keymap.len() {
        bail!(
            "{what} key position not found in keyboard keys (index {index}, keymap has {} entries)",
            keymap.len()
        );
    }
    Ok(())
}

/// Plan a SOCD bind (vendor `setKeyboardSocdKey`). `key_a`/`key_b` are
/// keymap indices of the two physical keys; `direction` is the vendor
/// socdList id 0–3. The history entry stores the keys' *current* values;
/// the keymap slots are rewritten to `base+dir` / `base+256+dir`.
pub fn plan_socd(
    blob: &[u8],
    keymap: &[u32],
    key_a: usize,
    key_b: usize,
    direction: u8,
) -> Result<AdvPlan> {
    if direction > 3 {
        bail!("SOCD direction must be 0..=3 (vendor socdList id), got {direction}");
    }
    if key_a == key_b {
        bail!("SOCD needs two distinct keys");
    }
    check_index(keymap, key_a, "SOCD key A")?;
    check_index(keymap, key_b, "SOCD key B")?;
    check_bindable(keymap[key_a], "SOCD key A")?;
    check_bindable(keymap[key_b], "SOCD key B")?;
    let entry = u32s_to_bytes(&[keymap[key_a], keymap[key_b]]);
    plan(blob, keymap, AdvKind::Socd, &entry, |base, km| {
        km[key_a] = base + direction as u32;
        km[key_b] = base + 256 + direction as u32;
    })
}

/// Plan an MT (mod-tap) bind (vendor `setKeyboardMtKey`). `key` is the
/// keymap index of the physical bind key; `tap`/`hold` are the raw u32
/// key values emitted on short/long press (vendor `shortCode`/`longCode`
/// — stored in the history entry in that order); `time` is the hold
/// threshold in 10 ms units (vendor slider value, UI range 0–100).
pub fn plan_mt(
    blob: &[u8],
    keymap: &[u32],
    key: usize,
    tap: u32,
    hold: u32,
    time: u16,
) -> Result<AdvPlan> {
    check_index(keymap, key, "MT bind key")?;
    check_bindable(keymap[key], "MT bind key")?;
    let entry = u32s_to_bytes(&[tap, hold]);
    plan(blob, keymap, AdvKind::Mt, &entry, |base, km| {
        km[key] = base + time as u32;
    })
}

/// Plan a TGL bind (vendor `setKeyboardTglKey`). `key` is the keymap
/// index of the physical bind key; `toggle` is the keymap index whose
/// *current value* is stored in the history entry (vendor `keyB` — the
/// UI only allows picking a physical key, so a position is required).
pub fn plan_tgl(blob: &[u8], keymap: &[u32], key: usize, toggle: usize) -> Result<AdvPlan> {
    check_index(keymap, key, "TGL bind key")?;
    check_index(keymap, toggle, "TGL toggle key")?;
    check_bindable(keymap[key], "TGL bind key")?;
    let entry = u32s_to_bytes(&[keymap[toggle]]);
    plan(blob, keymap, AdvKind::Tgl, &entry, |base, km| {
        km[key] = base;
    })
}

// ── Decoding (list / get) ────────────────────────────────────────────────

/// Decode the keymap u32 of an adv binding; `None` for non-adv values.
pub fn decode_adv_binding(value: u32) -> Option<(AdvKind, u32, AdvDetail)> {
    let kind = match value >> 24 {
        0x20 => AdvKind::Socd,
        0x21 => AdvKind::Mt,
        0x22 => AdvKind::Tgl,
        _ => return None,
    };
    let slot = (value >> 16) & 0xFF;
    let detail = match kind {
        AdvKind::Socd => AdvDetail::Socd {
            direction: (value & 0xFF) as u8,
            key_b: (value >> 8) & 1 != 0,
        },
        AdvKind::Mt => AdvDetail::Mt {
            time: (value & 0xFFFF) as u16,
        },
        AdvKind::Tgl => AdvDetail::Tgl,
    };
    Some((kind, slot, detail))
}

/// All adv bindings in a keymap read (arg 0), in keymap order.
pub fn scan_adv_bindings(keymap: &[u32]) -> Vec<AdvBinding> {
    keymap
        .iter()
        .enumerate()
        .filter_map(|(i, &v)| {
            decode_adv_binding(v).map(|(kind, slot, detail)| AdvBinding {
                index: i,
                pos: (8 + i * 4) as u32,
                value: v,
                kind,
                slot,
                detail,
            })
        })
        .collect()
}

/// All non-empty history slots of a (raw or normalized) blob.
pub fn history_entries(blob: &[u8]) -> Vec<HistoryEntry> {
    let b = normalize_blob(blob);
    let mut out = Vec::new();
    for kind in [AdvKind::Socd, AdvKind::Mt, AdvKind::Tgl] {
        let (rstart, rend) = kind.region_range();
        let region = &b[rstart..rend];
        let slot = kind.slot_bytes();
        for (i, chunk) in region.chunks(slot).enumerate() {
            if chunk.iter().all(|&x| x == 0) {
                continue;
            }
            let values = chunk
                .chunks_exact(4)
                .map(|c| u32::from_be_bytes([c[0], c[1], c[2], c[3]]))
                .collect();
            out.push(HistoryEntry {
                kind,
                slot: i,
                values,
            });
        }
    }
    out
}

/// The history payload bound by `binding`, resolved by slot index
/// (vendor slot field = position index under dense packing — the only
/// packing the vendor UI can produce, since it has no delete).
pub fn binding_payload(blob: &[u8], binding: &AdvBinding) -> Option<Vec<u32>> {
    let b = normalize_blob(blob);
    let (rstart, rend) = binding.kind.region_range();
    let slot_bytes = binding.kind.slot_bytes();
    let region = &b[rstart..rend];
    let start = binding.slot as usize * slot_bytes;
    if start + slot_bytes > region.len() {
        return None;
    }
    let chunk = &region[start..start + slot_bytes];
    if chunk.iter().all(|&x| x == 0) {
        return None;
    }
    Some(
        chunk
            .chunks_exact(4)
            .map(|c| u32::from_be_bytes([c[0], c[1], c[2], c[3]]))
            .collect(),
    )
}

/// Label for a raw u32 key value (reuses the keymap decoder).
pub fn value_label(value: u32) -> String {
    match decode_key_value(value) {
        KeyValue::Empty => String::new(),
        k => k.label(),
    }
}

// ── Wired session methods ────────────────────────────────────────────────

// Wired command opcodes used here (spec §6): the adv-key read/write pair
// is *not* the blacklisted reset (17) — cmd 18 is the vendor
// `sendAdvanKeyHistory` write and 146 the `getKeyboardAdvancedKey` read.
const CMD_ADV_KEY_WRITE: u8 = 18;
const CMD_ADV_KEY_READ: u8 = 146;

impl crate::Khub916 {
    /// Keymap values on the vendor `sendKeyConfiguration` channel:
    /// cmd 131, arg 0, tags 0/2 — the read counterpart of
    /// [`Self::write_key_configuration`] (distinct from
    /// [`crate::Khub916::key_values`]' 248/1 layer/system channel, which
    /// is what the adv setters *read* via `getKeyboardKeys({layer:0})`).
    ///
    /// The vendor JS never reads this channel back (its writes are
    /// fire-and-forget); this read exists so writes can be verified
    /// per the repo safety contract. On K1 Pro it returns the full
    /// 128-entry field (the 248/1 read trims trailing zeros to 126).
    pub fn key_configuration(&mut self) -> Result<Vec<u32>> {
        self.guard(|s| {
            let p = s.query(crate::CMD_KEYMAP_READ, 0x00, 0x00, 0x02)?;
            if p.len() % 4 != 0 {
                bail!(
                    "khub916 key configuration: payload {} bytes not a multiple of 4",
                    p.len()
                );
            }
            Ok(p.chunks_exact(4)
                .map(|c| u32::from_be_bytes([c[0], c[1], c[2], c[3]]))
                .collect())
        })
    }

    /// SOCD/MT/TGL history blob (cmd 146, tags 0/2 — vendor
    /// `getKeyboardAdvancedKey`). Returns the raw payload padded/truncated
    /// view as received; use [`normalize_blob`] for a fixed 512-byte view.
    pub fn adv_key_config(&mut self) -> Result<Vec<u8>> {
        self.guard(|s| s.query(CMD_ADV_KEY_READ, 0x00, 0x00, 0x02))
    }

    /// Write the 512-byte SOCD/MT/TGL history blob (cmd 18, tags 0/2 —
    /// vendor `sendAdvanKeyHistory`). Fire-and-forget like every config
    /// write. Read-back verify is **best-effort**: on K1 Pro (live-tested)
    /// cmd-146 returns unrelated firmware-memory pages for ~60 s after
    /// the write within the same session, and the write itself did not
    /// persist on that unit — this polls ~2 s and reports
    /// `verified: false` rather than failing. Treat cmd 18 as
    /// **code-verified, persistence unconfirmed** until tested on
    /// hardware that honours it.
    pub fn write_adv_key_config(&mut self, blob: &[u8]) -> Result<WriteOutcome> {
        if blob.len() != ADV_BLOB_BYTES {
            bail!(
                "khub916 adv-key write needs exactly {ADV_BLOB_BYTES} bytes, got {}",
                blob.len()
            );
        }
        let pkt = crate::Khub916::packet(CMD_ADV_KEY_WRITE, 0x00, 0x00, 0x02, blob)?;
        // Steps guarded individually (same convention as write_keymap):
        // transport errors poison, verify mismatch is a data error.
        self.config_write(&pkt)?;
        // cmd 18 is fire-and-forget and the device commits the blob
        // asynchronously — on K1 Pro cmd-146 returns unrelated
        // firmware-memory pages for ~60 s after the write within the
        // same session, and the write did not persist on that unit at
        // all. Poll briefly; report verified:false rather than fail so
        // callers can surface "sent, unconfirmed" honestly.
        let want = normalize_blob(blob);
        let mut back = self.adv_key_config()?;
        for attempt in 0..=10 {
            if normalize_blob(&back) == want {
                return Ok(WriteOutcome {
                    command: CMD_ADV_KEY_WRITE,
                    verified: true,
                });
            }
            if attempt == 10 {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(200));
            back = self.adv_key_config()?;
        }
        // Best-effort only: the write was sent vendor-identically; the
        // device is known to commit it (observed diff=0 on a lucky read).
        Ok(WriteOutcome {
            command: CMD_ADV_KEY_WRITE,
            verified: false,
        })
    }

    /// Write the keymap through the vendor `sendKeyConfiguration` header
    /// `[3, 0, 0, 1, 0, 0, 2]` — arg 0, tags 0/2 — used by every adv-key
    /// set operation (distinct from [`crate::Khub916::write_keymap`]'s
    /// 248/1 header). `values` is the u32 BE key list (≤128, zero-padded,
    /// `5A A5` end marker overwriting payload bytes 510/511).
    ///
    /// Verify: cmd-131 read-back on the same 0/2 channel
    /// ([`Self::key_configuration`]) must match zero-padded to 128
    /// entries (same convention as `write_keymap`).
    pub fn write_key_configuration(&mut self, values: &[u32]) -> Result<WriteOutcome> {
        if values.is_empty() || values.len() > crate::KEYMAP_ENTRIES {
            bail!(
                "khub916 key configuration write needs 1..={} values, got {}",
                crate::KEYMAP_ENTRIES,
                values.len()
            );
        }
        let mut payload = [0u8; crate::KEYMAP_ENTRIES * 4];
        for (i, v) in values.iter().enumerate() {
            payload[i * 4..i * 4 + 4].copy_from_slice(&v.to_be_bytes());
        }
        payload[crate::KEYMAP_ENTRIES * 4 - 2] = 0x5A;
        payload[crate::KEYMAP_ENTRIES * 4 - 1] = 0xA5;
        let pkt = crate::Khub916::packet(crate::CMD_KEYMAP_WRITE, 0x00, 0x00, 0x02, &payload)?;
        self.config_write(&pkt)?;
        // Expected read-back = `values` zero-padded to KEYMAP_ENTRIES with
        // the same `5A A5` trailer the write payload carries (bytes
        // 510/511 land inside u32 index 127). Same async-commit caveat as
        // the cmd-18 history write: poll the read-back briefly before
        // declaring a mismatch.
        let mut want = vec![0u32; crate::KEYMAP_ENTRIES];
        for (i, v) in values.iter().enumerate() {
            want[i] = *v;
        }
        want[crate::KEYMAP_ENTRIES - 1] =
            (want[crate::KEYMAP_ENTRIES - 1] & 0xFFFF_0000) | 0x5AA5;
        let mut back = self.key_configuration()?;
        if back.len() > crate::KEYMAP_ENTRIES {
            bail!(
                "khub916 key configuration read-back has {} entries (> {})",
                back.len(),
                crate::KEYMAP_ENTRIES
            );
        }
        for attempt in 0..=10 {
            if (0..crate::KEYMAP_ENTRIES)
                .all(|i| want[i] == back.get(i).copied().unwrap_or(0))
            {
                return Ok(WriteOutcome {
                    command: crate::CMD_KEYMAP_WRITE,
                    verified: true,
                });
            }
            if attempt == 10 {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
            back = self.key_configuration()?;
        }
        bail!("khub916 key configuration write not verified: read-back differs");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn zeros(n: usize) -> Vec<u8> {
        vec![0u8; n]
    }

    #[test]
    fn process_history_fills_first_zero_slot() {
        // Region with slot 0 occupied, slot 1 free.
        let mut region = zeros(16);
        region[0..8].copy_from_slice(&[1, 2, 3, 4, 5, 6, 7, 8]);
        let entry = [9u8, 9, 9, 9, 9, 9, 9, 9];
        let out = process_history(&region, &entry, 8).unwrap();
        assert_eq!(&out[8..16], &entry);
        assert_eq!(&out[0..8], &[1, 2, 3, 4, 5, 6, 7, 8]);
    }

    #[test]
    fn process_history_appends_when_full() {
        let region = [0xAAu8; 8];
        let entry = [1u8, 2, 3, 4];
        let out = process_history(&region, &entry, 8).unwrap();
        assert_eq!(out.len(), 12);
        assert_eq!(&out[8..12], &entry);
    }

    #[test]
    fn base_address_counts_nonzero_groups() {
        // Empty → base; one group → base; two → base+0x10000.
        assert_eq!(base_address(&zeros(16), 8, SOCD_BASE), SOCD_BASE);
        let mut r = zeros(16);
        r[0] = 1;
        assert_eq!(base_address(&r, 8, SOCD_BASE), SOCD_BASE);
        r[8] = 1;
        assert_eq!(base_address(&r, 8, SOCD_BASE), SOCD_BASE + 0x1_0000);
        // TGL slot size 4.
        let mut t = zeros(8);
        t[0] = 1;
        t[4] = 1;
        assert_eq!(base_address(&t, 4, TGL_BASE), TGL_BASE + 0x1_0000);
    }

    #[test]
    fn vendor_free_slot_needs_four_zeros() {
        assert!(vendor_free_slot(&zeros(200)));
        assert!(!vendor_free_slot(&[1, 2, 3, 4, 5, 6, 7, 8]));
        // Three zeros is not enough.
        assert!(!vendor_free_slot(&[0, 0, 0, 1]));
        assert!(vendor_free_slot(&[0, 0, 0, 0, 1]));
    }

    #[test]
    fn plan_socd_writes_history_and_keymap() {
        let blob = zeros(ADV_BLOB_BYTES);
        // Keymap: index 10 = 'A' (0x04), index 20 = 'B' (0x05).
        let mut km = vec![0u32; 64];
        km[10] = 0x0000_0004;
        km[20] = 0x0000_0005;
        let plan = plan_socd(&blob, &km, 10, 20, 1).unwrap();
        // First SOCD slot → base 0x20000000; keyA = base+dir, keyB = base+256+dir.
        assert_eq!(plan.keymap[10], SOCD_BASE + 1);
        assert_eq!(plan.keymap[20], SOCD_BASE + 256 + 1);
        // History entry at blob[0..8] = original values BE.
        assert_eq!(&plan.blob[0..8], &[0, 0, 0, 4, 0, 0, 0, 5]);
        // TGL footer bytes cleared.
        assert_eq!(plan.blob[510], 0);
        assert_eq!(plan.blob[511], 0);
        // Round-trip decode.
        let entries = history_entries(&plan.blob);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].kind, AdvKind::Socd);
        assert_eq!(entries[0].slot, 0);
        assert_eq!(entries[0].values, vec![4, 5]);
        let bindings = scan_adv_bindings(&plan.keymap);
        assert_eq!(bindings.len(), 2);
        assert_eq!(bindings[0].kind, AdvKind::Socd);
        assert_eq!(bindings[0].detail, AdvDetail::Socd { direction: 1, key_b: false });
        assert_eq!(bindings[1].detail, AdvDetail::Socd { direction: 1, key_b: true });
        assert_eq!(binding_payload(&plan.blob, &bindings[0]), Some(vec![4, 5]));
    }

    #[test]
    fn plan_mt_stores_tap_then_hold() {
        let blob = zeros(ADV_BLOB_BYTES);
        let mut km = vec![0u32; 64];
        km[3] = 0x0000_001D; // 'z'
        // tap = 'a' (4), hold = 'b' (5), time 50 (500 ms).
        let plan = plan_mt(&blob, &km, 3, 4, 5, 50).unwrap();
        assert_eq!(plan.keymap[3], MT_BASE + 50);
        // MT region starts at blob[200]; entry = [tap, hold] BE.
        assert_eq!(&plan.blob[200..208], &[0, 0, 0, 4, 0, 0, 0, 5]);
        let entries = history_entries(&plan.blob);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].kind, AdvKind::Mt);
        assert_eq!(entries[0].values, vec![4, 5]);
        let b = scan_adv_bindings(&plan.keymap);
        assert_eq!(b[0].detail, AdvDetail::Mt { time: 50 });
    }

    #[test]
    fn plan_tgl_stores_toggle_value() {
        let blob = zeros(ADV_BLOB_BYTES);
        let mut km = vec![0u32; 64];
        km[7] = 0x0000_0015; // bind key 'r'
        km[9] = 0x0002_001E; // toggle target Shift+1
        let plan = plan_tgl(&blob, &km, 7, 9).unwrap();
        // TGL base exact, no params.
        assert_eq!(plan.keymap[7], TGL_BASE);
        // TGL region starts at blob[400]; entry = toggle value BE.
        assert_eq!(&plan.blob[400..404], &[0x00, 0x02, 0x00, 0x1E]);
        let b = scan_adv_bindings(&plan.keymap);
        assert_eq!(b[0].detail, AdvDetail::Tgl);
        assert_eq!(binding_payload(&plan.blob, &b[0]), Some(vec![0x0002_001E]));
    }

    #[test]
    fn second_entry_gets_next_slot() {
        // Pre-fill SOCD slot 0, then plan another SOCD → slot 1, base+0x10000.
        let mut blob = zeros(ADV_BLOB_BYTES);
        blob[0..8].copy_from_slice(&[0, 0, 0, 4, 0, 0, 0, 5]);
        let mut km = vec![0u32; 64];
        km[1] = 1;
        km[2] = 2;
        let plan = plan_socd(&blob, &km, 1, 2, 0).unwrap();
        assert_eq!(plan.keymap[1], SOCD_BASE + 0x1_0000);
        assert_eq!(plan.keymap[2], SOCD_BASE + 0x1_0000 + 256);
        // Entry went to slot 1 (bytes 8..16).
        assert_eq!(&plan.blob[8..16], &[0, 0, 0, 1, 0, 0, 0, 2]);
    }

    #[test]
    fn plan_rejects_bound_and_missing_positions() {
        let blob = zeros(ADV_BLOB_BYTES);
        let mut km = vec![0u32; 8];
        km[1] = 0x20_00_00_01; // already an adv binding
        assert!(plan_socd(&blob, &km, 1, 2, 0).is_err());
        assert!(plan_socd(&blob, &km, 1, 99, 0).is_err());
        assert!(plan_mt(&blob, &km, 99, 1, 2, 50).is_err());
        assert!(plan_tgl(&blob, &km, 1, 99).is_err());
        assert!(plan_socd(&blob, &km, 2, 2, 0).is_err()); // same key twice
        assert!(plan_socd(&blob, &km, 2, 3, 4).is_err()); // bad direction
    }

    #[test]
    fn plan_fails_when_region_full() {
        // Fill every 8-byte SOCD slot (25 slots) with non-zero data and
        // remove any 4-zero run... vendor check needs 4 consecutive zeros;
        // craft a region with no 4-zero run.
        let mut blob = zeros(ADV_BLOB_BYTES);
        // Fill SOCD region with a repeating non-zero pattern that has no
        // 4 consecutive zeros: 01 02 03 04 repeating → windows of 4 are
        // never all zero.
        for i in 0..SOCD_REGION_BYTES {
            blob[i] = (i % 4 + 1) as u8;
        }
        let km = vec![1u32, 2];
        assert!(plan_socd(&blob, &km, 0, 1, 0).is_err());
    }

    #[test]
    fn normalize_blob_pads_short_reads() {
        let short = vec![0xABu8; 100];
        let b = normalize_blob(&short);
        assert_eq!(&b[..100], &short[..]);
        assert!(b[100..].iter().all(|&x| x == 0));
        let long = vec![0xCDu8; 600];
        let b2 = normalize_blob(&long);
        assert!(b2.iter().all(|&x| x == 0xCD));
    }

    #[test]
    fn decode_adv_binding_fields() {
        assert_eq!(decode_adv_binding(0x29), None);
        let (k, s, d) = decode_adv_binding(SOCD_BASE + 2).unwrap();
        assert_eq!(k, AdvKind::Socd);
        assert_eq!(s, 0);
        assert_eq!(d, AdvDetail::Socd { direction: 2, key_b: false });
        let (_, _, d) = decode_adv_binding(SOCD_BASE + 0x100 + 3).unwrap();
        assert_eq!(d, AdvDetail::Socd { direction: 3, key_b: true });
        let (_, s, d) = decode_adv_binding(MT_BASE + (5 << 16) + 42).unwrap();
        assert_eq!(s, 5);
        assert_eq!(d, AdvDetail::Mt { time: 42 });
        let (_, s, d) = decode_adv_binding(TGL_BASE + (7 << 16)).unwrap();
        assert_eq!(s, 7);
        assert_eq!(d, AdvDetail::Tgl);
    }

    /// Live hardware probe — run with
    /// `cargo test -p omg-proto-khub916 live_adv -- --ignored`.
    /// Performs a real TGL set (cmd 3 `sendKeyConfiguration` + cmd 18
    /// history) on the attached K1 Pro, inspects every read-back channel,
    /// then restores the exact prior keymap and blob. Mutates the device
    /// while running; never run in CI.
    #[test]
    #[ignore = "requires an attached khub916 wired keyboard; writes then restores device state"]
    fn live_adv_key_write_roundtrip() {
        use omg_hid::{find_devices, DeviceKind};
        let dev = find_devices()
            .expect("find_devices")
            .into_iter()
            .find(|d| d.kind == DeviceKind::Khub916Wired)
            .expect("no khub916 wired device attached");
        let mut link = dev.open_link().expect("open_link");
        let report_id = crate::probe_report_id(&mut link).expect("probe_report_id");
        let mut kb = crate::Khub916::new(Box::new(link), report_id);

        let blob0 = kb.adv_key_config().expect("adv_key_config");
        let blob0 = normalize_blob(&blob0);
        let km0 = kb.key_values(0).expect("key_values(0)");
        let kc0 = kb.key_configuration().expect("key_configuration");
        eprintln!(
            "snapshot: blob {}B, key_values(0) {} entries, key_configuration {} entries",
            blob0.len(),
            km0.len(),
            kc0.len()
        );

        // Bind an all-zero keymap position as TGL, toggling index 0.
        let key = km0.iter().position(|&v| v == 0).expect("empty keymap slot");
        let toggle = km0.iter().position(|&v| v != 0).expect("nonempty keymap slot");
        eprintln!("probe: key index {key}, toggle index {toggle}");
        let plan = plan_tgl(&blob0, &km0, key, toggle).expect("plan_tgl");
        let blob_diffs = plan
            .blob
            .iter()
            .zip(blob0.iter())
            .filter(|(a, b)| a != b)
            .count();
        eprintln!("plan: blob diff bytes {blob_diffs}, keymap[{key}] -> {:08X}", plan.keymap[key]);
        assert!(plan.keymap[key] >> 24 == 0x22, "expected TGL tag");

        // Never let a failed verify skip the restore: capture results,
        // inspect, restore, then report.
        let ko = kb.write_key_configuration(&plan.keymap);
        let ho = ko.as_ref().ok().map(|_| {
            kb.write_adv_key_config(&plan.blob)
        });
        eprintln!(
            "writes: keymap={:?} history={:?}",
            ko.as_ref().map(|o| (o.command, o.verified)),
            ho.as_ref().map(|r| r.as_ref().map(|o| (o.command, o.verified)))
        );

        // Inspect every read channel after the write.
        let km1 = kb.key_values(0).expect("post key_values(0)");
        let kc1 = kb.key_configuration().expect("post key_configuration");
        let b1 = normalize_blob(&kb.adv_key_config().expect("post adv_key_config"));
        eprintln!(
            "post: key_values(0)[{key}]={:08X} key_configuration[{key}]={:08X}",
            km1.get(key).copied().unwrap_or(0xDEAD),
            kc1.get(key).copied().unwrap_or(0xDEAD)
        );
        eprintln!(
            "post kc tail[124..]={:08X?}",
            &kc1[kc1.len().saturating_sub(4)..]
        );
        eprintln!(
            "post tgl entries: {:?}",
            history_entries(&b1)
                .iter()
                .filter(|e| e.kind == AdvKind::Tgl)
                .map(|e| (e.slot, e.values.clone()))
                .collect::<Vec<_>>()
        );
        eprintln!(
            "post blob diff vs plan: {} bytes; vs snapshot: {} bytes",
            b1.iter().zip(plan.blob.iter()).filter(|(a, b)| a != b).count(),
            b1.iter().zip(blob0.iter()).filter(|(a, b)| a != b).count()
        );
        eprintln!(
            "post blob[400..416]={}",
            b1[400..416].iter().map(|x| format!("{x:02X}")).collect::<String>()
        );

        // Restore the exact prior state on both channels.
        let rk = kb.write_key_configuration(&kc0);
        let rb = kb.write_adv_key_config(&blob0);
        eprintln!(
            "restore writes: keymap={:?} blob={:?}",
            rk.as_ref().map(|o| o.verified),
            rb.as_ref().map(|o| o.verified)
        );
        let kc2 = kb.key_configuration().expect("post-restore key_configuration");
        let b2 = normalize_blob(&kb.adv_key_config().expect("post-restore adv_key_config"));
        eprintln!(
            "restored: key_configuration==kc0? {} blob==blob0? {}",
            kc2 == kc0,
            b2 == blob0
        );
        ko.expect("keymap write");
        ho.expect("history write").expect("history write result");
    }

    /// Focused probe: write the *same* blob back via cmd 18 and watch how
    /// cmd 146 read-back converges (timing vs transformation).
    #[test]
    #[ignore = "requires an attached khub916 wired keyboard"]
    fn live_adv_blob_write_probe() {
        use omg_hid::{find_devices, DeviceKind};
        let dev = find_devices()
            .expect("find_devices")
            .into_iter()
            .find(|d| d.kind == DeviceKind::Khub916Wired)
            .expect("no khub916 wired device attached");
        let mut link = dev.open_link().expect("open_link");
        let report_id = crate::probe_report_id(&mut link).expect("probe_report_id");
        let mut kb = crate::Khub916::new(Box::new(link), report_id);

        // Restore mode: OMG_ADV_RESTORE_HEX=<file> writes those exact
        // bytes as the adv blob (used to undo live-test mutations).
        if let Ok(path) = std::env::var("OMG_ADV_RESTORE_HEX") {
            let hex: String = std::fs::read_to_string(&path)
                .expect("read hex file")
                .chars()
                .filter(|c| c.is_ascii_hexdigit())
                .collect();
            let blob: Vec<u8> = (0..hex.len() / 2)
                .map(|i| u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16).unwrap())
                .collect();
            assert_eq!(blob.len(), ADV_BLOB_BYTES);
            let w = kb.write_adv_key_config(&blob);
            eprintln!("restore write: {:?}", w.as_ref().map(|o| o.verified));
            std::thread::sleep(std::time::Duration::from_secs(3));
            let back = normalize_blob(&kb.adv_key_config().expect("read-back"));
            eprintln!("restore read-back match (in-session): {}", blob.as_slice() == back);
            return;
        }

        let blob0 = normalize_blob(&kb.adv_key_config().expect("adv_key_config"));
        // no-op write: send identical content
        let w = kb.write_adv_key_config(&blob0);
        eprintln!("no-op write result: {:?}", w.as_ref().map(|o| o.verified));
        // After cmd 18 the device returns firmware-memory garbage for
        // cmd 146. Try resyncing with a benign query first.
        for i in 0..12 {
            std::thread::sleep(std::time::Duration::from_millis(5000));
            if i == 2 {
                match kb.device_info() {
                    Ok(info) => eprintln!("device_info ok: {:?}", info.catalog_model),
                    Err(e) => eprintln!("device_info err: {e:#}"),
                }
            }
            match kb.adv_key_config() {
                Ok(raw) => {
                    let b = normalize_blob(&raw);
                    let d0 = b.iter().zip(blob0.iter()).filter(|(a, b)| a != b).count();
                    eprintln!(
                        "t+{}ms len={} diff={} head={}",
                        (i + 1) * 5000,
                        raw.len(),
                        d0,
                        b[..16].iter().map(|x| format!("{x:02X}")).collect::<String>()
                    );
                }
                Err(e) => eprintln!("t+{}ms read err: {e:#}", (i + 1) * 5000),
            }
        }
    }
}
