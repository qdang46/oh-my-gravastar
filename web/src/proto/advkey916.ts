/**
 * khub916 advanced keys (SOCD / MT / TGL) codec — TypeScript port of
 * `crates/proto-khub916/src/advkey.rs` (itself a port of the vendor
 * `Ht`/`zt` engine paths in `docs/research/khub-webapp/
 * index-M8-m9qFR.deob.js`). Data model: `docs/advkeys-schema.md`;
 * wire detail: `docs/protocol-khub916.md` §6/§7.
 *
 * An adv key = two device writes, in vendor order:
 *
 * 1. **Keymap binding** — one or two slots of the arg-0 keymap
 *    (`key_values(0)`, cmd 131 tags 248/1) are rewritten to
 *    `base + params` where `base` is `0x20/0x21/0x22 SS 00 00`-style:
 *    SOCD `0x20000000`, MT `0x21000000`, TGL `0x22000000`, `SS` =
 *    history slot index in bits 16..23. The write itself goes through
 *    the `sendKeyConfiguration` channel — cmd 3 arg 0 tags 0/2 (see
 *    `keyConfigurationWritePacket`), *not* the 248/1 `keymapWritePacket`
 *    used by ordinary remaps.
 * 2. **History blob** — a 512-byte table (SOCD 200 B + MT 200 B +
 *    TGL 112 B of fixed slots) gains an entry holding the keys'
 *    original values. Written via cmd 18 arg 0 tags 0/2
 *    (`advKeyWritePacket`).
 *
 * There is **no delete**: the vendor UI's delete only edits a
 * localStorage cache. Removing an adv key means overwriting its
 * keymap binding (e.g. with 0); the history slot stays.
 *
 * Verification level (docs/advkeys-schema.md): keymap half
 * live-verified; cmd-18 history write is code-verified — on K1 Pro it
 * did NOT persist and cmd-146 read-back returns unrelated pages for
 * ~60 s after the write. The session reports `verified: false`
 * honestly instead of failing.
 */

import { CMD, buildPacket, keymapWritePayload, keyValueLabelOf } from './khub916.ts';

// ── Blob layout constants ──────────────────────────────────────────────

/** Total history blob size: 200 + 200 + 112. */
export const ADV_BLOB_BYTES = 512;
/** SOCD region: blob[0..200], 8-byte slots (25 slots). */
export const SOCD_REGION_BYTES = 200;
/** MT region: blob[200..400], 8-byte slots (25 slots). */
export const MT_REGION_BYTES = 200;
/** TGL region: blob[400..512], 4-byte slots (28 slots). */
export const TGL_REGION_BYTES = 112;
/** Slot size for SOCD and MT entries (two u32 key values). */
export const HISTORY_SLOT_BYTES = 8;
/** Slot size for TGL entries (one u32 key value). */
export const TGL_SLOT_BYTES = 4;

/** Keymap-value base addresses; low 16 bits free for parameters,
 *  bits 16..23 carry the history slot index. */
export const SOCD_BASE = 0x2000_0000;
export const MT_BASE = 0x2100_0000;
export const TGL_BASE = 0x2200_0000;

/** Keymap type tags that mark macro/SOCD/MT/TGL references — the vendor
 *  refuses to (re)bind a position whose current value carries one. */
export const ADV_FORBIDDEN_TAGS: readonly number[] = [0x03, 0x20, 0x21, 0x22];

// ── Model ──────────────────────────────────────────────────────────────

export type AdvKind = 'socd' | 'mt' | 'tgl';

export const ADV_KINDS: readonly AdvKind[] = ['mt', 'socd', 'tgl'];

export const KIND_LABEL: Record<AdvKind, string> = {
  socd: 'SOCD',
  mt: 'MT',
  tgl: 'TGL',
};

export type AdvDetail =
  | { kind: 'socd'; direction: number; keyB: boolean }
  | { kind: 'mt'; time: number }
  | { kind: 'tgl' };

export interface AdvBinding {
  /** Keymap index (0-based); vendor `pos = 8 + index*4`. */
  index: number;
  pos: number;
  /** Raw keymap u32. */
  value: number;
  kind: AdvKind;
  /** History slot index carried in bits 16..23 of the value. */
  slot: number;
  detail: AdvDetail;
}

export interface HistoryEntry {
  kind: AdvKind;
  /** Slot index = byte offset / slot size within the kind's region. */
  slot: number;
  /** u32 BE values stored in the slot (SOCD: [keyA,keyB] originals,
   *  MT: [tap,hold], TGL: [toggle target]). */
  values: number[];
}

/** Result of planning an adv-key set: the full 512-byte history blob
 *  and the full replacement keymap (same length as the input read). */
export interface AdvPlan {
  blob: Uint8Array;
  keymap: number[];
}

// ── Blob normalization / region access ─────────────────────────────────

/** Copy `blob` into a fixed 512-byte view, zero-padding a short read
 *  (the device may trim trailing zeros; equivalent because the trimmed
 *  bytes are always zero). */
export function normalizeBlob(blob: Uint8Array): Uint8Array {
  const out = new Uint8Array(ADV_BLOB_BYTES);
  out.set(blob.subarray(0, ADV_BLOB_BYTES));
  return out;
}

function regionRange(kind: AdvKind): [number, number] {
  switch (kind) {
    case 'socd':
      return [0, SOCD_REGION_BYTES];
    case 'mt':
      return [SOCD_REGION_BYTES, SOCD_REGION_BYTES + MT_REGION_BYTES];
    case 'tgl':
      return [SOCD_REGION_BYTES + MT_REGION_BYTES, ADV_BLOB_BYTES];
  }
}

function slotBytes(kind: AdvKind): number {
  return kind === 'tgl' ? TGL_SLOT_BYTES : HISTORY_SLOT_BYTES;
}

function kindBase(kind: AdvKind): number {
  switch (kind) {
    case 'socd':
      return SOCD_BASE;
    case 'mt':
      return MT_BASE;
    case 'tgl':
      return TGL_BASE;
  }
}

// ── Vendor algorithms (faithful ports of advkey.rs) ────────────────────

/**
 * Vendor `processHistory`: copy `region`, scan slots of `slot` bytes
 * from offset 0; the first all-zero slot receives `entry`. If no
 * all-zero slot exists the entry is *appended* — callers must check
 * `vendorFreeSlot` first so the region cannot outgrow its table.
 */
function processHistory(region: Uint8Array, entry: Uint8Array, slot: number): Uint8Array {
  const n = region.slice();
  let placed = false;
  for (let o = 0; o < n.length && !placed; o += slot) {
    const end = Math.min(o + slot, n.length);
    let allZero = true;
    for (let i = o; i < end; i++) {
      if (n[i] !== 0) {
        allZero = false;
        break;
      }
    }
    if (allZero) {
      for (let c = 0; o + c < n.length && c < entry.length; c++) {
        n[o + c] = entry[c] ?? 0;
      }
      placed = true;
    }
  }
  if (!placed) {
    const out = new Uint8Array(n.length + entry.length);
    out.set(n);
    out.set(entry, n.length);
    return out;
  }
  return n;
}

/** Vendor free-slot pre-check: any run of 4 consecutive zero bytes in
 *  the region — used for all three kinds regardless of slot size. */
function vendorFreeSlot(region: Uint8Array): boolean {
  if (region.length < 4) return false;
  for (let i = 0; i + 4 <= region.length; i++) {
    if (region[i] === 0 && region[i + 1] === 0 && region[i + 2] === 0 && region[i + 3] === 0) {
      return true;
    }
  }
  return false;
}

/** Vendor `calculateBaseAddress` family: count non-zero `slot`-byte
 *  groups; base for 0 or 1 groups, otherwise `base + (count-1)*0x10000`.
 *  Note the vendor counts *non-zero groups*, not the highest index —
 *  bug-compatible port. */
function baseAddress(region: Uint8Array, slot: number, base: number): number {
  let nonzero = 0;
  // Rust `chunks(slot)` semantics: a trailing partial chunk counts too.
  for (let o = 0; o < region.length; o += slot) {
    const end = Math.min(o + slot, region.length);
    let any = false;
    for (let i = o; i < end; i++) {
      if (region[i] !== 0) {
        any = true;
        break;
      }
    }
    if (any) nonzero++;
  }
  return nonzero <= 1 ? base : (base + (nonzero - 1) * 0x1_0000) >>> 0;
}

/** Reject a keymap value whose type tag is macro/SOCD/MT/TGL (the
 *  vendor `s=[3,32,33,34]` check before binding a position). */
function checkBindable(value: number, what: string): void {
  const tag = (value >>> 24) & 0xff;
  if (ADV_FORBIDDEN_TAGS.includes(tag)) {
    throw new Error(
      `${what}: keymap value 0x${hex8(value)} already carries a macro/adv-key tag — unbind it first`,
    );
  }
}

function u32sToBytes(values: readonly number[]): Uint8Array {
  const out = new Uint8Array(values.length * 4);
  values.forEach((v, i) => {
    const n = v >>> 0;
    out[i * 4] = (n >>> 24) & 0xff;
    out[i * 4 + 1] = (n >>> 16) & 0xff;
    out[i * 4 + 2] = (n >>> 8) & 0xff;
    out[i * 4 + 3] = n & 0xff;
  });
  return out;
}

function checkIndex(keymap: readonly number[], index: number, what: string): void {
  if (!Number.isInteger(index) || index < 0 || index >= keymap.length) {
    throw new Error(
      `${what} key position not found in keyboard keys (index ${index}, keymap has ${keymap.length} entries)`,
    );
  }
}

// ── Write planning (pure; unit-tested in scripts/smoke.ts) ─────────────

/** Shared tail of the three planners: validate, run `processHistory`
 *  on the kind's region, compute the base address and assemble the
 *  512-byte blob (with the vendor's `tgl[110]=tgl[111]=0` footer clear
 *  applied to every write). */
function plan(
  blob: Uint8Array,
  keymap: readonly number[],
  kind: AdvKind,
  entry: Uint8Array,
  apply: (base: number, km: number[]) => void,
): AdvPlan {
  const b = normalizeBlob(blob);
  // Vendor clears TGL region bytes 110/111 (= blob 510/511) on every
  // adv-key write, whatever kind is being set.
  b[ADV_BLOB_BYTES - 2] = 0;
  b[ADV_BLOB_BYTES - 1] = 0;

  const [rstart, rend] = regionRange(kind);
  const region = b.subarray(rstart, rend);
  if (!vendorFreeSlot(region)) {
    throw new Error(`no available ${kind.toUpperCase()} slot found. Maximum ${kind.toUpperCase()} keys limit reached.`);
  }
  const newRegion = processHistory(region, entry, slotBytes(kind));
  if (newRegion.length > rend - rstart) {
    throw new Error(`no available ${kind.toUpperCase()} slot found (region overflow)`);
  }
  const base = baseAddress(newRegion, slotBytes(kind), kindBase(kind));

  const km = keymap.map((v) => v >>> 0);
  apply(base, km);

  // Reassemble: replace only the target region inside the normalized
  // blob (the other two regions are carried verbatim).
  b.set(newRegion.subarray(0, rend - rstart), rstart);
  return { blob: b, keymap: km };
}

/**
 * Plan a SOCD bind (vendor `setKeyboardSocdKey`). `key_a`/`key_b` are
 * keymap indices of the two physical keys; `direction` is the vendor
 * socdList id 0–3. The history entry stores the keys' *current* values;
 * the keymap slots are rewritten to `base+dir` / `base+256+dir`.
 */
export function planSocd(
  blob: Uint8Array,
  keymap: readonly number[],
  keyA: number,
  keyB: number,
  direction: number,
): AdvPlan {
  if (!Number.isInteger(direction) || direction < 0 || direction > 3) {
    throw new Error(`SOCD direction must be 0..=3 (vendor socdList id), got ${direction}`);
  }
  if (keyA === keyB) {
    throw new Error('SOCD needs two distinct keys');
  }
  checkIndex(keymap, keyA, 'SOCD key A');
  checkIndex(keymap, keyB, 'SOCD key B');
  checkBindable(keymap[keyA] ?? 0, 'SOCD key A');
  checkBindable(keymap[keyB] ?? 0, 'SOCD key B');
  const entry = u32sToBytes([keymap[keyA] ?? 0, keymap[keyB] ?? 0]);
  return plan(blob, keymap, 'socd', entry, (base, km) => {
    km[keyA] = (base + direction) >>> 0;
    km[keyB] = (base + 256 + direction) >>> 0;
  });
}

/**
 * Plan an MT (mod-tap) bind (vendor `setKeyboardMtKey`). `key` is the
 * keymap index of the physical bind key; `tap`/`hold` are the raw u32
 * key values emitted on short/long press (vendor `shortCode`/`longCode`
 * — stored in the history entry in that order); `time` is the hold
 * threshold in 10 ms units (vendor slider value, UI range 0–100).
 */
export function planMt(
  blob: Uint8Array,
  keymap: readonly number[],
  key: number,
  tap: number,
  hold: number,
  time: number,
): AdvPlan {
  checkIndex(keymap, key, 'MT bind key');
  checkBindable(keymap[key] ?? 0, 'MT bind key');
  if (!Number.isInteger(time) || time < 0 || time > 0xffff) {
    throw new Error(`MT hold time must be an integer 0..65535 (10 ms units), got ${time}`);
  }
  const entry = u32sToBytes([tap, hold]);
  return plan(blob, keymap, 'mt', entry, (base, km) => {
    km[key] = (base + time) >>> 0;
  });
}

/**
 * Plan a TGL bind (vendor `setKeyboardTglKey`). `key` is the keymap
 * index of the physical bind key; `toggle` is the keymap index whose
 * *current value* is stored in the history entry (vendor `keyB` — the
 * UI only allows picking a physical key, so a position is required).
 */
export function planTgl(blob: Uint8Array, keymap: readonly number[], key: number, toggle: number): AdvPlan {
  checkIndex(keymap, key, 'TGL bind key');
  checkIndex(keymap, toggle, 'TGL toggle key');
  checkBindable(keymap[key] ?? 0, 'TGL bind key');
  const entry = u32sToBytes([keymap[toggle] ?? 0]);
  return plan(blob, keymap, 'tgl', entry, (base, km) => {
    km[key] = base >>> 0;
  });
}

// ── Decoding (list / get) ──────────────────────────────────────────────

/** Decode the keymap u32 of an adv binding; null for non-adv values. */
export function decodeAdvBinding(value: number): { kind: AdvKind; slot: number; detail: AdvDetail } | null {
  const v = value >>> 0;
  let kind: AdvKind;
  switch (v >>> 24) {
    case 0x20:
      kind = 'socd';
      break;
    case 0x21:
      kind = 'mt';
      break;
    case 0x22:
      kind = 'tgl';
      break;
    default:
      return null;
  }
  const slot = (v >>> 16) & 0xff;
  let detail: AdvDetail;
  if (kind === 'socd') {
    detail = { kind: 'socd', direction: v & 0xff, keyB: ((v >>> 8) & 1) !== 0 };
  } else if (kind === 'mt') {
    detail = { kind: 'mt', time: v & 0xffff };
  } else {
    detail = { kind: 'tgl' };
  }
  return { kind, slot, detail };
}

/** All adv bindings in a keymap read (arg 0), in keymap order. */
export function scanAdvBindings(keymap: readonly number[]): AdvBinding[] {
  const out: AdvBinding[] = [];
  keymap.forEach((v, i) => {
    const d = decodeAdvBinding(v);
    if (d) {
      out.push({
        index: i,
        pos: 8 + i * 4,
        value: v >>> 0,
        kind: d.kind,
        slot: d.slot,
        detail: d.detail,
      });
    }
  });
  return out;
}

/** All non-empty history slots of a (raw or normalized) blob. */
export function historyEntries(blob: Uint8Array): HistoryEntry[] {
  const b = normalizeBlob(blob);
  const out: HistoryEntry[] = [];
  for (const kind of ADV_KINDS_ORDER) {
    const [rstart, rend] = regionRange(kind);
    const region = b.subarray(rstart, rend);
    const slot = slotBytes(kind);
    // Rust `chunks(slot)` semantics (regions are exact multiples anyway).
    for (let o = 0; o < region.length; o += slot) {
      const chunk = region.subarray(o, Math.min(o + slot, region.length));
      let allZero = true;
      for (const x of chunk) {
        if (x !== 0) {
          allZero = false;
          break;
        }
      }
      if (allZero) continue;
      const values: number[] = [];
      for (let c = 0; c + 4 <= chunk.length; c += 4) {
        values.push(
          (((chunk[c] ?? 0) << 24) | ((chunk[c + 1] ?? 0) << 16) | ((chunk[c + 2] ?? 0) << 8) | (chunk[c + 3] ?? 0)) >>> 0,
        );
      }
      out.push({ kind, slot: o / slot, values });
    }
  }
  return out;
}

const ADV_KINDS_ORDER: readonly AdvKind[] = ['socd', 'mt', 'tgl'];

/** The history payload bound by `binding`, resolved by slot index
 *  (vendor slot field = position index under dense packing — the only
 *  packing the vendor UI can produce, since it has no delete). */
export function bindingPayload(blob: Uint8Array, binding: AdvBinding): number[] | null {
  const b = normalizeBlob(blob);
  const [rstart, rend] = regionRange(binding.kind);
  const sb = slotBytes(binding.kind);
  const region = b.subarray(rstart, rend);
  const start = binding.slot * sb;
  if (start + sb > region.length) return null;
  const chunk = region.subarray(start, start + sb);
  let allZero = true;
  for (const x of chunk) {
    if (x !== 0) {
      allZero = false;
      break;
    }
  }
  if (allZero) return null;
  const values: number[] = [];
  for (let c = 0; c + 4 <= chunk.length; c += 4) {
    values.push(
      (((chunk[c] ?? 0) << 24) | ((chunk[c + 1] ?? 0) << 16) | ((chunk[c + 2] ?? 0) << 8) | (chunk[c + 3] ?? 0)) >>> 0,
    );
  }
  return values;
}

/** Label for a raw u32 key value (reuses the keymap decoder; '' for
 *  empty values, same as the Rust `advkey::value_label`). */
export function valueLabel(value: number): string {
  return keyValueLabelOf(value);
}

// ── Packet builders ────────────────────────────────────────────────────

/**
 * Adv-key history write packet (cmd 18, arg 0, tags 0/2 — vendor
 * `sendAdvanKeyHistory`). `blob` must be exactly 512 bytes. Fire-and-
 * forget like every config write; verify by cmd-146 read-back.
 */
export function advKeyWritePacket(blob: Uint8Array): Uint8Array {
  if (blob.length !== ADV_BLOB_BYTES) {
    throw new Error(`khub916 adv-key write needs exactly ${ADV_BLOB_BYTES} bytes, got ${blob.length}`);
  }
  return buildPacket(CMD.advKeyWrite, 0x00, 0x00, 0x02, blob);
}

/**
 * Keymap write packet for the adv-key `sendKeyConfiguration` channel:
 * cmd 3 arg 0 tags 0/2 — header `[3,0,0,1,0,0,2]`, same 512-byte
 * zero-padded u32 payload + `5A A5` marker as `keymapWritePacket`
 * (distinct tags: this is *not* the 248/1 layer/system write).
 */
export function keyConfigurationWritePacket(values: readonly number[]): Uint8Array {
  if (values.length === 0 || values.length > 128) {
    throw new Error(`khub916 key configuration write needs 1..=128 values, got ${values.length}`);
  }
  return buildPacket(CMD.keymapWrite, 0x00, 0x00, 0x02, keymapWritePayload(values));
}

function hex8(v: number): string {
  return `0x${(v >>> 0).toString(16).toUpperCase().padStart(8, '0')}`;
}

export { hex8 as advHex8 };
