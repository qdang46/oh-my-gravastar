/**
 * khub916 wired protocol — pure packet builders/parsers.
 *
 * TypeScript port of `crates/proto-khub916/src/lib.rs` (read path only).
 * Binding spec: `docs/protocol-khub916.md`. Transport (WebHID feature
 * reports) lives in `../hid.ts`; this module is DOM-free so it can be
 * smoke-tested under plain Node.
 *
 * Request header (7 bytes): `[cmd, arg, 0x00, 0x01, 0x00, tagA, tagB]`,
 * payload follows at offset 7, packet zero-padded to 519 bytes. There is
 * no checksum/sequence/ACK; the device echoes the 7-byte header.
 */

// ── Wire constants (spec §2/§6) ────────────────────────────────────────

/** Feature-report payload size: every request is zero-padded to this. */
export const FEATURE_PAYLOAD_BYTES = 519;
/** Echoed request header length; payload starts right after it. */
export const HEADER_LEN = 7;
export const KEYMAP_ENTRIES = 128;
export const CUSTOM_LIGHT_ENTRIES = 126;

/** Wired query opcodes (decimal values from spec §6). */
export const CMD = {
  keymapWrite: 3,
  profileWrite: 4,
  macroWrite: 5,
  customLightWrite: 6,
  lightDataWrite: 10, // wired cmd-10 light-data write (proto/light.ts)
  deviceInfo: 130, // 0x82
  keymapRead: 131, // 0x83
  profileRead: 132, // 0x84
  macroRead: 133, // 0x85
  customLightRead: 134, // 0x86
  powerRead: 135, // 0x87
  lightDataRead: 138, // 0x8A
  advKeyWrite: 18, // sendAdvanKeyHistory — SOCD/MT/TGL history blob
  advKeyRead: 146, // getKeyboardAdvancedKey — adv-key history blob
} as const;

// ── Device UUID / model catalog (spec §1, vendor `Dp` table) ───────────

export interface CatalogEntry {
  model: string;
  name: string;
  /** 6-byte device UUID as `0x…` hex — the vendor "password". */
  uuidHex: string;
  /** Vendor legend table selector (0 default, 3 JP); null = not established. */
  keyType: number | null;
}

/** GravaStar entries of the vendor catalog (spec §1 table). */
export const CATALOG: readonly CatalogEntry[] = [
  { model: '916_K1', name: 'GravaStar Mercury K1', uuidHex: '0x0300000001b4', keyType: 0 },
  { model: '916_K1_PRO', name: 'GravaStar Mercury K1 PRO', uuidHex: '0x030000000197', keyType: 0 },
  { model: '916_K1_LITE', name: 'GravaStar Mercury K1 LITE', uuidHex: '0x0300000001b5', keyType: 0 },
  { model: '916_K98Pro', name: 'K98', uuidHex: '0x0600000000b3', keyType: 0 },
  { model: '916_GravaStar_Mercury_NP_PRO', name: 'GravaStar Mercury NP PRO', uuidHex: '0x0600000000ad', keyType: 0 },
  { model: '916_GravaStar_Mercury_NP', name: 'GravaStar Mercury NP', uuidHex: '0x0600000000d4', keyType: 0 },
  { model: '916_K1_JP', name: 'GravaStar Mercury K1 (JP)', uuidHex: '0x030000000401', keyType: 3 },
  { model: '916_K1_LITE_JP', name: 'GravaStar Mercury K1 LITE (JP)', uuidHex: '0x030000000402', keyType: 3 },
  { model: '916_K1_LITE_PRO_JP', name: 'GravaStar Mercury K1 LITE PRO (JP)', uuidHex: '0x030000000400', keyType: 3 },
  { model: '916_K1_PRO_DE', name: 'GravaStar Mercury K1 PRO (DE)', uuidHex: '0x0300000003f4', keyType: null },
  { model: '916_K1_DE', name: 'GravaStar Mercury K1 (DE)', uuidHex: '0x0300000003f5', keyType: null },
  { model: '916_K1_LITE_DE', name: 'GravaStar Mercury K1 LITE (DE)', uuidHex: '0x0300000003f6', keyType: null },
  { model: '916_K98Pro_JP', name: 'K98 (JP)', uuidHex: '0x06000000010c', keyType: 3 },
  { model: '916_K98Pro_DE', name: 'K98 (DE)', uuidHex: '0x060000000104', keyType: null },
  { model: '916_K98Pro_SE', name: 'K98 (SE)', uuidHex: '0x060000000110', keyType: null },
  { model: '916_K98Pro_KR', name: 'K98 (KR)', uuidHex: '0x060000000113', keyType: null },
];

/** Catalog row for a UUID hex string (`0x…`, case-insensitive). */
export function catalogLookup(uuidHex: string): CatalogEntry | undefined {
  const norm = uuidHex.toLowerCase();
  return CATALOG.find((e) => e.uuidHex === norm);
}

/** Encode 6 payload bytes as the vendor UUID hex form `0x030000000197`. */
export function uuidHex(bytes: Uint8Array): string {
  let s = '0x';
  for (let i = 0; i < 6; i++) s += (bytes[i] ?? 0).toString(16).padStart(2, '0');
  return s;
}

// ── Screen geometry codes (`Ha` map, spec §4) ───────────────────────────

const SCREEN_DIMS: Record<number, [number, number]> = {
  1: [128, 128],
  2: [160, 80],
  3: [240, 135],
  4: [240, 240],
  5: [320, 172],
  6: [428, 142],
  7: [170, 320],
};

// ── Packet builder ─────────────────────────────────────────────────────

/**
 * Build the 519-byte feature payload: 7-byte header + command payload,
 * zero-padded. Bytes 2/3/4 are the constant `00 01 00` triple.
 */
export function buildPacket(
  cmd: number,
  arg: number,
  tagA: number,
  tagB: number,
  payload: Uint8Array = new Uint8Array(0),
): Uint8Array {
  if (HEADER_LEN + payload.length > FEATURE_PAYLOAD_BYTES) {
    throw new Error(
      `khub916 packet too large: ${HEADER_LEN} + ${payload.length} > ${FEATURE_PAYLOAD_BYTES}`,
    );
  }
  const pkt = new Uint8Array(FEATURE_PAYLOAD_BYTES);
  pkt[0] = cmd;
  pkt[1] = arg;
  pkt[3] = 0x01;
  pkt[5] = tagA;
  pkt[6] = tagB;
  pkt.set(payload, HEADER_LEN);
  return pkt;
}

/** Header-only query packet (all wired reads are header-only). */
export function queryPacket(cmd: number, arg: number, tagA: number, tagB: number): Uint8Array {
  return buildPacket(cmd, arg, tagA, tagB);
}

/** True when `resp` echoes the 7-byte request header `pkt`. */
export function echoMatches(pkt: Uint8Array, resp: Uint8Array): boolean {
  if (resp.length < HEADER_LEN) return false;
  for (let i = 0; i < HEADER_LEN; i++) {
    if (resp[i] !== pkt[i]) return false;
  }
  return true;
}

/** Response payload = bytes after the echoed 7-byte header. */
export function responsePayload(resp: Uint8Array): Uint8Array {
  return resp.slice(HEADER_LEN);
}

// ── Response parsers ───────────────────────────────────────────────────

export interface DeviceInfo {
  /** 6-byte UUID as `0x…` hex (the vendor "password" / model key). */
  uuid: string;
  /** Raw firmware version word (`0x0100` observed on K1 Pro). */
  version: number;
  versionHex: string;
  /** Vendor screen-size code; 0 = no screen on the keyboard interface. */
  screenSize: number;
  /** Decoded screen geometry when `screenSize` is a known code. */
  screen: [number, number] | null;
  catalogModel: string | null;
  catalogName: string | null;
}

/** Parse cmd-130 payload: uuid6 + u16 BE version + screen byte. */
export function parseDeviceInfo(p: Uint8Array): DeviceInfo {
  if (p.length < 9) {
    throw new Error(`khub916 device info: short payload ${p.length} bytes`);
  }
  const uuid = uuidHex(p);
  const version = ((p[6] ?? 0) << 8) | (p[7] ?? 0);
  const screenSize = p[8] ?? 0;
  const entry = catalogLookup(uuid);
  return {
    uuid,
    version,
    versionHex: `0x${version.toString(16).padStart(4, '0')}`,
    screenSize,
    screen: SCREEN_DIMS[screenSize] ?? null,
    catalogModel: entry?.model ?? null,
    catalogName: entry?.name ?? null,
  };
}

export interface PowerInfo {
  /** Battery percent 0–100 as reported by the firmware. */
  percent: number;
  /** Raw status flags byte (bit semantics unconfirmed, spec §8). */
  flags: number;
}

/** Parse cmd-135 payload `[level, flags]`. */
export function parsePower(p: Uint8Array): PowerInfo {
  if (p.length < 2) {
    throw new Error(`khub916 power: short payload ${p.length} bytes`);
  }
  return { percent: p[0] ?? 0, flags: p[1] ?? 0 };
}

/** Parse cmd-131 payload: N × u32 big-endian key values. */
export function parseKeyValues(p: Uint8Array): number[] {
  if (p.length % 4 !== 0) {
    throw new Error(`khub916 keymap: payload ${p.length} bytes not a multiple of 4`);
  }
  const out: number[] = [];
  for (let i = 0; i + 3 < p.length; i += 4) {
    out.push(
      (((p[i] ?? 0) << 24) | ((p[i + 1] ?? 0) << 16) | ((p[i + 2] ?? 0) << 8) | (p[i + 3] ?? 0)) >>> 0,
    );
  }
  return out;
}

export interface ProfileInfo {
  raw: Uint8Array;
  /** Current light mode: `raw[9]!=0 ? raw[9]<<8|raw[10] : raw[10]`. */
  lightMode: number | null;
  /** Keyboard sleep time in seconds (`profile[24]`). */
  sleepSeconds: number | null;
}

/** Wrap the cmd-132 profile/config blob (~128 B). */
export function parseProfile(raw: Uint8Array): ProfileInfo {
  let lightMode: number | null = null;
  if (raw.length >= 11) {
    lightMode = raw[9] !== 0 ? ((raw[9] ?? 0) << 8) | (raw[10] ?? 0) : (raw[10] ?? 0);
  }
  return {
    raw,
    lightMode,
    sleepSeconds: raw.length > 24 ? (raw[24] ?? null) : null,
  };
}

/**
 * Vendor `setKeyboardSleepTime` / Rust `Profile::with_sleep_seconds`:
 * copy of the profile blob with `raw[24] = seconds`. Everything else —
 * including the trailing `5A A5` marker — is preserved verbatim.
 * Throws when the blob is too short for the field or `seconds` is not a
 * u8. Pure function; the caller owns the cmd-4 write + read-back verify.
 */
export function profileWithSleepSeconds(raw: Uint8Array, seconds: number): Uint8Array {
  if (raw.length <= 24) {
    throw new Error(`khub916 profile too short for sleep field: ${raw.length} bytes`);
  }
  if (!Number.isInteger(seconds) || seconds < 0 || seconds > 255) {
    throw new Error(`khub916 sleep seconds out of range: ${seconds}`);
  }
  const v = raw.slice();
  v[24] = seconds;
  return v;
}

export interface LightColor {
  index: number;
  /** Position in the keymap domain: `pos = 8 + index*4`. */
  pos: number;
  r: number;
  g: number;
  b: number;
}

/**
 * Parse cmd-134 payload: 378 bytes = 126 R + 126 G + 126 B plane bytes.
 */
export function parseCustomLightColors(p: Uint8Array): LightColor[] {
  if (p.length < CUSTOM_LIGHT_ENTRIES * 3) {
    throw new Error(`khub916 custom light: short payload ${p.length} bytes`);
  }
  const out: LightColor[] = [];
  for (let i = 0; i < CUSTOM_LIGHT_ENTRIES; i++) {
    out.push({
      index: i,
      pos: 8 + i * 4,
      r: p[i] ?? 0,
      g: p[CUSTOM_LIGHT_ENTRIES + i] ?? 0,
      b: p[2 * CUSTOM_LIGHT_ENTRIES + i] ?? 0,
    });
  }
  return out;
}

/**
 * cmd-138 light colour data (~480 B blob; per-mode 21-byte RGB groups at
 * `mode*21`). Returned raw — layout interpretation is stubbed in the MVP.
 */
export function parseLightColorData(p: Uint8Array): Uint8Array {
  return p.slice();
}

/**
 * cmd-133 macro region (≤512 B assembled table). Returned raw — decode it
 * with `proto/macro916.ts::parseMacroRegion` (spec §6).
 */
export function parseMacroRegion(p: Uint8Array): Uint8Array {
  return p.slice();
}

// ── Write packets (fire-and-forget; verify by read-back) ───────────────

/**
 * Keymap write payload (cmd 3): the u32 BE key values zero-padded to a
 * fixed 512-byte payload whose **last two bytes are the `5A A5` end
 * marker** (packet bytes 517/518 = payload bytes 510/511). Mirrors
 * `Khub916::write_keymap` in `crates/proto-khub916/src/lib.rs`.
 */
export function keymapWritePayload(values: readonly number[]): Uint8Array {
  if (values.length === 0 || values.length > KEYMAP_ENTRIES) {
    throw new Error(
      `khub916 keymap write needs 1..=${KEYMAP_ENTRIES} values, got ${values.length}`,
    );
  }
  const payload = new Uint8Array(KEYMAP_ENTRIES * 4);
  values.forEach((v, i) => {
    const n = v >>> 0;
    payload[i * 4] = (n >>> 24) & 0xff;
    payload[i * 4 + 1] = (n >>> 16) & 0xff;
    payload[i * 4 + 2] = (n >>> 8) & 0xff;
    payload[i * 4 + 3] = n & 0xff;
  });
  payload[KEYMAP_ENTRIES * 4 - 2] = 0x5a;
  payload[KEYMAP_ENTRIES * 4 - 1] = 0xa5;
  return payload;
}

/**
 * Keymap write packet (cmd 3, tags 248/1). `layer`/`system` pack into
 * `arg = layer & 3 | (system & 1) << 2` (spec §6).
 */
export function keymapWritePacket(layer: number, system: number, values: readonly number[]): Uint8Array {
  const arg = (layer & 3) | ((system & 1) << 2);
  return buildPacket(CMD.keymapWrite, arg, 0xf8, 0x01, keymapWritePayload(values));
}

/**
 * Macro region write packet (cmd 5): `region` (the assembled ≤512 B
 * table) is zero-padded to the vendor's fixed 512-byte payload; the
 * header is `[5,0,0,1,0,len&0xFF,0]` with len=512 → tag byte 0
 * (`setKeyBoardMacroIndependent` in the vendor JS).
 */
export function macroWritePacket(region: Uint8Array): Uint8Array {
  if (region.length === 0 || region.length > 512) {
    throw new Error(`khub916 macro write needs 1..=512 bytes, got ${region.length}`);
  }
  const payload = new Uint8Array(512);
  payload.set(region);
  // Vendor sends `[5,0,0,1,0,v.length,0]` with v.length = 512, which
  // wraps to 0 in the Uint8Array — tagA is `len & 0xFF`.
  return buildPacket(CMD.macroWrite, 0x00, 512 & 0xff, 0x00, payload);
}

// ── Key value decoding (spec §6 "Key value encoding") ──────────────────

export type KeyValue =
  | { kind: 'empty' }
  | { kind: 'normal'; usage: number; ctrl: boolean; shift: boolean; alt: boolean; gui: boolean }
  | { kind: 'fn'; layer: number }
  | { kind: 'macro'; macroType: number; number: number; index: number }
  | { kind: 'secondary'; raw: number }
  | { kind: 'socd'; raw: number }
  | { kind: 'mt'; raw: number }
  | { kind: 'tgl'; raw: number }
  | { kind: 'unknown'; raw: number };

/** Decode one big-endian u32 keymap value. Tag = bits 31..24 (spec §6). */
export function decodeKeyValue(v: number): KeyValue {
  if (v === 0) return { kind: 'empty' };
  const tag = v >>> 24;
  switch (tag) {
    case 0x00:
      return {
        kind: 'normal',
        usage: v & 0xffff,
        ctrl: (v & 0x00010000) !== 0,
        shift: (v & 0x00020000) !== 0,
        alt: (v & 0x00040000) !== 0,
        gui: (v & 0x00080000) !== 0,
      };
    case 0x03:
      return {
        kind: 'macro',
        macroType: (v >>> 16) & 0xff,
        number: (v >>> 8) & 0xff,
        index: v & 0xff,
      };
    case 0x07:
      return { kind: 'secondary', raw: v };
    case 0x0d:
      return { kind: 'fn', layer: (v >>> 16) & 0xff };
    case 0x20:
      return { kind: 'socd', raw: v };
    case 0x21:
      return { kind: 'mt', raw: v };
    case 0x22:
      return { kind: 'tgl', raw: v };
    default:
      return { kind: 'unknown', raw: v };
  }
}

// ── HID usage → label (EN only; port of crates/model key_label) ────────

const FIXED_LABELS: Record<number, string> = {
  0x28: 'Enter',
  0x29: 'Esc',
  0x2a: 'Backspace',
  0x2b: 'Tab',
  0x39: 'Caps',
  0x46: 'PrtSc',
  0x47: 'ScrLk',
  0x48: 'Pause',
  0x49: 'Ins',
  0x4a: 'Home',
  0x4b: 'PgUp',
  0x4c: 'Del',
  0x4d: 'End',
  0x4e: 'PgDn',
  0x4f: '→',
  0x50: '←',
  0x51: '↓',
  0x52: '↑',
  0x65: 'Menu',
  0xf101: 'Fn',
};

const PUNCT_US: Record<number, string> = {
  0x2d: '-',
  0x2e: '=',
  0x2f: '[',
  0x30: ']',
  0x31: '\\',
  0x32: '#',
  0x33: ';',
  0x34: "'",
  0x35: '`',
  0x36: ',',
  0x37: '.',
  0x38: '/',
  0x64: '\\',
};

/**
 * Legend for a HID usage id (English table only — port of
 * `crates/model/src/lib.rs::key_label` with `german=false`). Falls back to
 * hex for unnamed usages.
 */
export function hidUsageLabel(code: number): string {
  const fixed = FIXED_LABELS[code];
  if (fixed !== undefined || code === 0x2c) return fixed ?? '';
  const punct = PUNCT_US[code];
  if (punct !== undefined) return punct;
  if (code >= 0x04 && code <= 0x1d) return String.fromCharCode(0x41 + (code - 0x04));
  if (code >= 0x1e && code <= 0x26) return String(code - 0x1d);
  if (code === 0x27) return '0';
  if (code >= 0x3a && code <= 0x45) return `F${code - 0x39}`;
  if (code === 0) return '';
  return code.toString(16).toUpperCase();
}

/**
 * Human-readable label for a decoded key value. Plain HID usages go through
 * [`hidUsageLabel`]; modifier order is Ctrl, Shift, Alt, Win.
 */
export function keyValueLabel(kv: KeyValue): string {
  switch (kv.kind) {
    case 'empty':
      return '';
    case 'normal': {
      const mods: string[] = [];
      if (kv.ctrl) mods.push('Ctrl');
      if (kv.shift) mods.push('Shift');
      if (kv.alt) mods.push('Alt');
      if (kv.gui) mods.push('Win');
      // usage 0 with modifier bits = bare modifier key (spec §6 note).
      if (kv.usage === 0) return mods.join('+');
      const prefix = mods.length ? mods.join('+') + '+' : '';
      return prefix + hidUsageLabel(kv.usage);
    }
    case 'fn':
      return kv.layer === 0 ? 'Fn' : `Fn${kv.layer}`;
    case 'macro':
      return `Macro(${kv.macroType},${kv.number},${kv.index})`;
    case 'secondary':
      return `Layer2(0x${kv.raw.toString(16).toUpperCase().padStart(8, '0')})`;
    case 'socd':
      return 'SOCD';
    case 'mt':
      return 'MT';
    case 'tgl':
      return 'TGL';
    case 'unknown':
      return `0x${kv.raw.toString(16).toUpperCase().padStart(8, '0')}`;
  }
}

/** Convenience: decode a raw u32 keymap value straight to a label. */
export function keyValueLabelOf(v: number): string {
  return keyValueLabel(decodeKeyValue(v));
}
