/**
 * GravaStar Mercury HE keyboard "v2" protocol — pure packet
 * builders/parsers.
 *
 * TypeScript port of `crates/proto-he/src/lib.rs` (`omg-proto-he`).
 * Binding spec: `docs/protocol-he-v2.md`; vendor-JS extraction notes in
 * `docs/research/he-macros-research.md`. Transport (WebHID output/input
 * reports, report id 0) lives in `../he.ts`; this module is DOM-free so
 * it can be smoke-tested under plain Node.
 *
 * Wire format: every request is a 64-byte output report with report id
 * 0: `[category, command, args…]` zero-padded. The keyboard answers with
 * a 64-byte input report echoing category and command (and, for some
 * commands, the row/col arguments). Multi-byte values are little
 * endian; distances are micrometres (mm × 1000). There is no
 * save/commit command — the firmware persists every write itself.
 *
 * Safety: the blacklisted commands of docs/protocol-he-v2.md §"Never
 * sent" are absent by omission — no builder exists for category 8
 * (firmware), `0A` (custom passthrough), `0x0C/0x0E/0x0F`
 * (display/voice/haptic), `10` (gamepad/handle), or the blacklisted
 * global sub-commands (`02 01` factory reset, `02 02` save, `02 09`
 * default switch, `02 0F` restart). Keycodes `0xF200`/`0xF203` are
 * rejected on every write path (`keycodeBlacklisted`).
 */

// ── Identity (crates/hid/src/devices.rs, orbit keyboard.rs) ────────────

/** Vendor ids the official driver routes to the v2 (HE) protocol. */
export const HE_VIDS = [0x1ca6, 0x31e3] as const;

/** Vendor collection usage page for the v2 protocol (0xFFB0). */
export const HE_USAGE_PAGE = 0xffb0;

/**
 * Product ids the official web driver routes to the v2 (HE) protocol
 * (decimal literals, same as `HE_PIDS` in crates/hid/src/devices.rs).
 */
export const HE_PIDS: readonly number[] = [
  11272, 11273, 11282, 11275, 11276, 11288, 11289, 11296, 11297, 11290, 11291, 11292, 11293,
  11274, 11278, 11277, 4896, 11283, 11284, 11305, 11306, 11300, 11298,
];

/** True when (vid, pid, usagePage) is a known HE v2 keyboard interface. */
export function matchesHeDevice(vid: number, pid: number, usagePage: number): boolean {
  return HE_VIDS.includes(vid as (typeof HE_VIDS)[number]) && HE_PIDS.includes(pid) && usagePage === HE_USAGE_PAGE;
}

/** One HIDDeviceFilter per VID:PID pair (requestDevice ORs the list). */
export function heDeviceFilters(): HIDDeviceFilter[] {
  const filters: HIDDeviceFilter[] = [];
  for (const vendorId of HE_VIDS) {
    for (const productId of HE_PIDS) {
      filters.push({ vendorId, productId, usagePage: HE_USAGE_PAGE });
    }
  }
  return filters;
}

// ── Wire constants ─────────────────────────────────────────────────────

/** Every report is exactly 64 bytes, report id 0 (no id byte on the wire). */
export const REPORT_BYTES = 64;
/** Columns (keys) per matrix row. */
export const KEY_COLUMNS = 21;
/** Palette entries per lighting zone. */
export const PALETTE_SIZE = 8;
/** Max actions per macro page (`07 04` packet). */
export const MACRO_PAGE_ACTIONS = 15;
/** Highest matrix row polled by `keySlots` (rows 0..7, 0xFF terminator). */
export const MAX_MATRIX_ROW = 8;

/** Protocol categories (vendor enum `aw`). */
export const CAT = {
  device: 1,
  global: 2,
  layout: 3,
  performance: 4,
  lighting: 5,
  higherKey: 6,
  macro: 7,
} as const;

/** Category-2 (global) sub-commands (vendor enum `IC`). */
export const GLOBAL_CMD = {
  config: 3, // profile count/active/switch
  system: 4, // OS mode
  reportRate: 5,
  calibration: 6,
  lightingAreas: 8,
  rtPrecision: 12,
  lightingSleep: 13,
  macroSpaceInfo: 14,
} as const;

const READ_LIST = 0;
const READ = 1;
const WRITE = 2;

/** Category-3 (layout & keymap) sub-commands. */
export const LAYOUT_CMD = {
  keyRowRead: 1,
  keyRowWrite: 2,
  keyCodeRead: 3,
  keyCodeWrite: 4,
  keyLayoutStyle: 5, // physical geometry
  keyLayoutDefault: 6,
} as const;

/** Category-4 (performance) sub-commands. */
export const PERF_CMD = {
  keyRead: 1,
  keyWrite: 2,
  liveTravel: 3, // `04 03 <sel> <row>`
} as const;

/** Category-5 (lighting) sub-commands. */
export const LIGHT_CMD = {
  read: 1, // `05 01 <zone> <what>`
  write: 2, // `05 02 <zone> <what> …`
  whatEffect: 0,
  whatPalette: 1,
} as const;

/** Category-6 (HigherKey) operation byte. */
export const HK_OP = { read: 1, write: 2 } as const;

/** HigherKey mode byte values (vendor `kw` enum). */
export const HK_MODE = {
  none: 0,
  dks: 1,
  mpt: 2,
  mt: 3,
  tgl: 4,
  end: 5,
  socd: 6,
  rs: 7,
} as const;
export type HkModeName = keyof typeof HK_MODE;

/** Category-7 (macro) sub-commands. */
export const MACRO_CMD = {
  modeRead: 1,
  modeWrite: 2,
  dataRead: 3,
  dataWrite: 4,
} as const;

/** Polling-rate labels by index (`02 05` list/get). */
export const REPORT_RATES = ['8K', '4K', '2K', '1K', '500', '250', '125'] as const;

/** Performance modes (`04 01`/`04 02` byte 4). */
export const MODE_FIXED = 0;
export const MODE_RAPID = 1;

// ── Low-level helpers ──────────────────────────────────────────────────

function u16le(v: number): [number, number] {
  const n = v & 0xffff;
  return [n & 0xff, (n >> 8) & 0xff];
}

/** Read u16 LE at byte offset `i` (throws on short buffer). */
export function rd16(d: ArrayLike<number>, i: number): number {
  if (i + 1 >= d.length) throw new Error(`he: short reply at offset ${i}`);
  return ((d[i] ?? 0) | ((d[i + 1] ?? 0) << 8)) & 0xffff;
}

/** Millimetres → wire micrometres u16 LE (clamped like the Rust port). */
export function um(mm: number): [number, number] {
  const v = Math.round(mm * 1000);
  return u16le(Math.min(Math.max(v, 0), 65535));
}

/** Wire u16 micrometres → millimetres. */
export function umToMm(v: number): number {
  return v / 1000;
}

/**
 * Build a 64-byte report `[category, command, args…]` zero-padded.
 * Throws when the payload exceeds 64 bytes.
 */
export function buildReport(parts: readonly number[] | Uint8Array): Uint8Array {
  const n = parts.length;
  if (n > REPORT_BYTES) {
    throw new Error(`he packet too large: ${n} > ${REPORT_BYTES}`);
  }
  const pkt = new Uint8Array(REPORT_BYTES);
  if (parts instanceof Uint8Array) pkt.set(parts.subarray(0, n));
  else pkt.set(parts.slice(0, n));
  return pkt;
}

/**
 * True when reply `resp` echoes the first `matchLen` bytes of request
 * `pkt` (category+command, or deeper for row/col-addressed commands).
 */
export function reportEchoMatches(pkt: Uint8Array, resp: Uint8Array, matchLen: number): boolean {
  if (resp.length < matchLen) return false;
  for (let i = 0; i < matchLen; i++) {
    if (resp[i] !== pkt[i]) return false;
  }
  return true;
}

/** Normalise a reply DataView/bytes to a 64-byte Uint8Array (zero-padded). */
export function normalizeReply(d: ArrayLike<number>): Uint8Array {
  const out = new Uint8Array(REPORT_BYTES);
  const n = Math.min(d.length, REPORT_BYTES);
  for (let i = 0; i < n; i++) out[i] = d[i] ?? 0;
  return out;
}

function hex(b: ArrayLike<number>): string {
  return Array.from({ length: Math.min(b.length, 8) }, (_, i) =>
    (b[i] ?? 0).toString(16).padStart(2, '0').toUpperCase(),
  ).join(' ');
}

// ── Device (category 1) ────────────────────────────────────────────────

/** `01 01` reply: protocol version bytes 2–3 (main.sub). */
export function parseProtocolVersion(d: Uint8Array): string {
  return `${d[2] ?? 0}.${d[3] ?? 0}`;
}

export interface KeyboardInfo {
  /** Protocol version string `"major.sub"` from `01 01`. */
  protocol: string;
  /** Board id, big-endian u32 at bytes 4–7 of `01 02`. */
  boardId: number;
  boardIdHex: string;
  /** Firmware version `"a.b.c.d"` from bytes 8–11 of `01 02`. */
  firmware: string;
  /** PCB version `"a-b-c-d"` from bytes 12–15 of `01 02`. */
  pcb: string;
  /** Build time ASCII from byte 29 of `01 02` (reformatted when shaped). */
  buildTime: string;
}

/** Parse the `01 02` info reply (expects the full 64-byte report). */
export function parseDeviceInfoReply(d: Uint8Array): Omit<KeyboardInfo, 'protocol'> {
  const boardId =
    (((d[4] ?? 0) << 24) | ((d[5] ?? 0) << 16) | ((d[6] ?? 0) << 8) | (d[7] ?? 0)) >>> 0;
  let ts = '';
  for (let i = 29; i < d.length && d[i] !== 0; i++) ts += String.fromCharCode(d[i] ?? 0);
  // Upstream reformats "YYYYMMDDHHMMSSxx"-ish 16-char strings; the Rust
  // port triggers on len==16 with ':' at index 10.
  const buildTime =
    ts.length === 16 && ts.charCodeAt(10) === 0x3a
      ? `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)} ${ts.slice(8)}`
      : ts;
  return {
    boardId,
    boardIdHex: `0x${boardId.toString(16).padStart(8, '0')}`,
    firmware: [d[8], d[9], d[10], d[11]].map((b) => b ?? 0).join('.'),
    pcb: [d[12], d[13], d[14], d[15]].map((b) => b ?? 0).join('-'),
    buildTime,
  };
}

// ── Layout & keymap (category 3) ───────────────────────────────────────

export interface KeySlot {
  row: number;
  col: number;
  /** Position in key units (quarter-key raw / 4). */
  x: number;
  y: number;
  /** Width/size code: 1=1u … 12=knob (docs/protocol-he-v2.md). */
  size: number;
}

/**
 * Parse one `03 05` geometry reply row. Each matrix column is a packed
 * u16 at byte `3 + 2·col`: bits 15–11 = y×4, bits 10–4 = x×4,
 * bits 3–0 = size code. Zero entries are skipped.
 */
export function parseKeySlots(row: number, d: Uint8Array): KeySlot[] {
  const slots: KeySlot[] = [];
  for (let col = 0; col < KEY_COLUMNS; col++) {
    const v = rd16(d, 3 + 2 * col);
    const size = v & 15;
    if (v === 0 || size === 0) continue;
    slots.push({
      row,
      col,
      y: ((v >> 11) & 31) / 4,
      x: ((v >> 4) & 127) / 4,
      size,
    });
  }
  return slots;
}

/** Parse a `03 01` reply: 21 u16-LE keycodes from byte 4. */
export function parseKeyCodes(d: Uint8Array): number[] {
  const codes: number[] = [];
  for (let i = 0; i < KEY_COLUMNS; i++) codes.push(rd16(d, 4 + 2 * i));
  return codes;
}

/** Keycodes that must never be written (long-press = factory reset / calibration). */
export function keycodeBlacklisted(code: number): boolean {
  return code === 0xf200 || code === 0xf203;
}

/** `03 02` whole-row keymap write payload (21 × u16 LE after the header). */
export function keyRowWriteReport(layer: number, row: number, codes: readonly number[]): Uint8Array {
  if (codes.length !== KEY_COLUMNS) {
    throw new Error(`he key-row write needs ${KEY_COLUMNS} codes, got ${codes.length}`);
  }
  for (const c of codes) {
    if (keycodeBlacklisted(c)) {
      throw new Error(`keycode 0x${c.toString(16).toUpperCase().padStart(4, '0')} is blacklisted`);
    }
  }
  const pkt = new Uint8Array(4 + KEY_COLUMNS * 2);
  pkt.set([CAT.layout, LAYOUT_CMD.keyRowWrite, layer, row]);
  codes.forEach((c, i) => {
    const [lo, hi] = u16le(c);
    pkt[4 + 2 * i] = lo;
    pkt[5 + 2 * i] = hi;
  });
  return pkt;
}

/** `03 04` single-key write report `[3,4,layer,row,col,lo,hi]`. */
export function keyCodeWriteReport(layer: number, row: number, col: number, code: number): Uint8Array {
  if (keycodeBlacklisted(code)) {
    throw new Error(`keycode 0x${code.toString(16).toUpperCase().padStart(4, '0')} is blacklisted`);
  }
  const [lo, hi] = u16le(code);
  return new Uint8Array([CAT.layout, LAYOUT_CMD.keyCodeWrite, layer, row, col, lo, hi]);
}

/** `03 06` default-layout query: selector byte = `system << 4 | func`. */
export function defaultLayoutReport(system: number, func: number, row: number): Uint8Array {
  if (system >= 16 || func >= 16) {
    throw new Error('he default layout: system/func must fit a nibble');
  }
  return new Uint8Array([CAT.layout, LAYOUT_CMD.keyLayoutDefault, (system << 4) | func, row]);
}

export interface DefaultKeyLayout {
  system: number;
  func: number;
  row: number;
  keyCodes: number[];
}

/** Parse a `03 06` reply into the factory-default row keycodes. */
export function parseDefaultLayoutReply(d: Uint8Array): DefaultKeyLayout {
  return {
    system: (d[2] ?? 0) >> 4,
    func: (d[2] ?? 0) & 15,
    row: d[3] ?? 0,
    keyCodes: parseKeyCodes(d),
  };
}

// ── Performance (category 4) ───────────────────────────────────────────

export interface KeyPerf {
  /** 0 = fixed actuation, 1 = rapid trigger. */
  mode: number;
  /** Actuation point (fixed mode), mm. */
  normalPress: number;
  /** Release point (fixed mode), mm — official driver writes 0. */
  normalRelease: number;
  /** First actuation (rapid-trigger mode), mm. */
  rtFirstTouch: number;
  /** RT press sensitivity, mm. */
  rtPress: number;
  /** RT release sensitivity, mm. */
  rtRelease: number;
  /** Top deadzone, mm (0–1). */
  pressDeadzone: number;
  /** Bottom deadzone, mm (0–1). */
  releaseDeadzone: number;
  // Switch characteristics — echoed back unchanged on write.
  /** Switch index (echo, byte 19). */
  axis: number;
  /** Calibration flag (echo, byte 20 — official driver writes 0). */
  calibrate: number;
  /** Switch id (echo, u16 @21; 13232 = GravaStar UFO, max travel 3.5 mm). */
  axisV2Id: number;
  /** Switch range (echo, u16 @23). */
  axisRangeMax: number;
  /** Switch coefficient (echo, u16 @25). */
  axisCoefficient: number;
}

function mmAt(d: Uint8Array, i: number): number {
  return rd16(d, i) / 1000;
}

/** Parse a `04 01` reply into one key's performance settings. */
export function parseKeyPerf(d: Uint8Array): KeyPerf {
  return {
    mode: d[4] ?? 0,
    normalPress: mmAt(d, 5),
    normalRelease: mmAt(d, 7),
    rtFirstTouch: mmAt(d, 9),
    rtPress: mmAt(d, 11),
    rtRelease: mmAt(d, 13),
    pressDeadzone: mmAt(d, 15),
    releaseDeadzone: mmAt(d, 17),
    axis: d[19] ?? 0,
    calibrate: d[20] ?? 0,
    axisV2Id: rd16(d, 21),
    axisRangeMax: rd16(d, 23),
    axisCoefficient: rd16(d, 25),
  };
}

/**
 * `04 02` write report for one key's performance settings.
 * Hardware-unverified: ported from the vendor JS / orbit; the caller
 * must carry the switch echo fields (axis/calibrate/axisV2Id/
 * axisRangeMax/axisCoefficient) over from a prior `keyPerf` read.
 */
export function keyPerfReport(row: number, col: number, p: KeyPerf): Uint8Array {
  const pkt = new Uint8Array(27);
  pkt.set([CAT.performance, PERF_CMD.keyWrite, row, col, p.mode & 0xff]);
  const distances = [
    p.normalPress,
    p.normalRelease,
    p.rtFirstTouch,
    p.rtPress,
    p.rtRelease,
    p.pressDeadzone,
    p.releaseDeadzone,
  ];
  distances.forEach((v, i) => {
    const [lo, hi] = um(v);
    pkt[5 + 2 * i] = lo;
    pkt[6 + 2 * i] = hi;
  });
  pkt[19] = p.axis & 0xff;
  pkt[20] = p.calibrate & 0xff;
  const echoes: [number, number][] = [
    [21, p.axisV2Id],
    [23, p.axisRangeMax],
    [25, p.axisCoefficient],
  ];
  for (const [off, v] of echoes) {
    const [lo, hi] = u16le(v);
    pkt[off] = lo;
    pkt[off + 1] = hi;
  }
  return pkt;
}

export interface LiveKey {
  /** Travel in mm (u16 µm wire value / 1000). */
  travelMm: number;
  /** Per-key actuated flag. */
  actuated: boolean;
}

/**
 * Combine the `04 03 01 <row>` travel reply and the `04 03 03 <row>`
 * status reply into 21 per-key live readings.
 */
export function parseLiveRow(travel: Uint8Array, status: Uint8Array): LiveKey[] {
  const out: LiveKey[] = [];
  for (let i = 0; i < KEY_COLUMNS; i++) {
    out.push({
      travelMm: rd16(travel, 4 + 2 * i) / 1000,
      actuated: rd16(status, 4 + 2 * i) !== 0,
    });
  }
  return out;
}

// ── Category 6: HigherKey (advanced keys) ──────────────────────────────
//
// All layouts below are inferred from the vendor v2 web-driver JS
// (docs/research/he-macros-research.md) and are hardware-unverified.
// Request header: `[6, op, row, col, mode]`; op 1 = read, 2 = write.

export interface DksParams {
  kcs: [number, number, number, number];
  trps: [number, number, number, number];
  /** Deadband distances in mm (wire: µm). */
  dbs: [number, number];
}
export interface MptParams {
  kcs: [number, number, number];
  dbs: [number, number, number];
}
export interface MtParams {
  kcs: [number, number];
  /** Raw u16 time (units unverified — driver passes through). */
  time: number;
}
export interface TglParams {
  kcs: number;
  time: number;
}
export interface EndParams {
  kcs: [number, number];
  delay: number;
}
/** SOCD direction selection (vendor `xw` enum). */
export type SocdDirection = 'cover' | 'priorityA' | 'priorityB' | 'neutral';
const SOCD_PAIRS: Record<SocdDirection, [number, number]> = {
  cover: [0, 0],
  priorityA: [1, 2],
  priorityB: [2, 1],
  neutral: [3, 3],
};
function socdDirectionFromByte(v: number): SocdDirection | null {
  switch (v) {
    case 0: return 'cover';
    case 1: return 'priorityA';
    case 2: return 'priorityB';
    case 3: return 'neutral';
    default: return null;
  }
}
export interface SocdParams {
  /** Partner key coordinates (cross-linked pair). */
  row2: number;
  col2: number;
  kcs: [number, number];
  delay: number;
  direction: SocdDirection;
}
/** RS parameters — same cross-linked two-packet shape as SOCD, no direction byte. */
export interface RsParams {
  row2: number;
  col2: number;
  kcs: [number, number];
  delay: number;
}

/** Write-side HigherKey configuration (row/col are method arguments). */
export type HigherKeyParams =
  | { mode: 'none' }
  | { mode: 'dks'; params: DksParams }
  | { mode: 'mpt'; params: MptParams }
  | { mode: 'mt'; params: MtParams }
  | { mode: 'tgl'; params: TglParams }
  | { mode: 'end'; params: EndParams }
  | { mode: 'socd'; params: SocdParams }
  | { mode: 'rs'; params: RsParams };

/** Mode byte for a write-side params object. */
export function hkModeOf(p: HigherKeyParams): number {
  return HK_MODE[p.mode];
}

/** Every keycode carried by a params object (for blacklist checks). */
export function hkKeyCodes(p: HigherKeyParams): number[] {
  switch (p.mode) {
    case 'none': return [];
    case 'dks': return [...p.params.kcs];
    case 'mpt': return [...p.params.kcs];
    case 'mt': return [...p.params.kcs];
    case 'tgl': return [p.params.kcs];
    case 'end': return [...p.params.kcs];
    case 'socd': return [...p.params.kcs];
    case 'rs': return [...p.params.kcs];
  }
}

function pushU16(pkt: number[], v: number): void {
  const [lo, hi] = u16le(v);
  pkt.push(lo, hi);
}
function pushUm(pkt: number[], mm: number): void {
  const [lo, hi] = um(mm);
  pkt.push(lo, hi);
}

/**
 * Build the write report(s) for one key's HigherKey config.
 * SOCD and RS produce two cross-linked packets (sent in order).
 * Blacklisted keycodes are rejected. Hardware-unverified.
 */
export function higherKeyWriteReports(row: number, col: number, p: HigherKeyParams): Uint8Array[] {
  for (const kc of hkKeyCodes(p)) {
    if (keycodeBlacklisted(kc)) {
      throw new Error(`higher-key keycode 0x${kc.toString(16).toUpperCase().padStart(4, '0')} is blacklisted`);
    }
  }
  const mode = hkModeOf(p);
  const header = (r: number, c: number): number[] => [CAT.higherKey, HK_OP.write, r, c, mode];
  switch (p.mode) {
    case 'none':
      return [buildReport(header(row, col))];
    case 'dks': {
      const pkt = header(row, col);
      for (const kc of p.params.kcs) pushU16(pkt, kc);
      pkt.push(...p.params.trps);
      for (const db of p.params.dbs) pushUm(pkt, db);
      return [buildReport(pkt)];
    }
    case 'mpt': {
      const pkt = header(row, col);
      for (const kc of p.params.kcs) pushU16(pkt, kc);
      for (const db of p.params.dbs) pushUm(pkt, db);
      return [buildReport(pkt)];
    }
    case 'mt': {
      const pkt = header(row, col);
      for (const kc of p.params.kcs) pushU16(pkt, kc);
      pushU16(pkt, p.params.time);
      return [buildReport(pkt)];
    }
    case 'tgl': {
      const pkt = header(row, col);
      pushU16(pkt, p.params.kcs);
      pushU16(pkt, p.params.time);
      return [buildReport(pkt)];
    }
    case 'end': {
      const pkt = header(row, col);
      for (const kc of p.params.kcs) pushU16(pkt, kc);
      pushU16(pkt, p.params.delay);
      return [buildReport(pkt)];
    }
    case 'socd': {
      const s = p.params;
      const [dirA, dirB] = SOCD_PAIRS[s.direction];
      const a = header(row, col);
      a.push(s.row2, s.col2);
      for (const kc of s.kcs) pushU16(a, kc);
      pushU16(a, s.delay);
      a.push(dirA);
      // Partner packet names this key and swaps the keycode order.
      const b = header(s.row2, s.col2);
      b.push(row, col);
      for (const kc of [...s.kcs].reverse()) pushU16(b, kc);
      pushU16(b, s.delay);
      b.push(dirB);
      return [buildReport(a), buildReport(b)];
    }
    case 'rs': {
      const r = p.params;
      const a = header(row, col);
      a.push(r.row2, r.col2);
      for (const kc of r.kcs) pushU16(a, kc);
      pushU16(a, r.delay);
      const b = header(r.row2, r.col2);
      b.push(row, col);
      for (const kc of [...r.kcs].reverse()) pushU16(b, kc);
      pushU16(b, r.delay);
      return [buildReport(a), buildReport(b)];
    }
  }
}

/** Decoded HigherKey state of one key (read reply or write echo). */
export type HigherKeyConfig =
  | { mode: 'none'; row: number; col: number }
  | { mode: 'dks'; row: number; col: number; params: DksParams }
  | { mode: 'mpt'; row: number; col: number; params: MptParams }
  | { mode: 'mt'; row: number; col: number; params: MtParams }
  | { mode: 'tgl'; row: number; col: number; params: TglParams }
  | { mode: 'end'; row: number; col: number; params: EndParams }
  | { mode: 'socd'; row: number; col: number; params: SocdParams }
  | { mode: 'rs'; row: number; col: number; params: RsParams };

/**
 * Decode a `[6, op, row, col, mode, …]` reply (read or write echo).
 * Returns null for unknown mode bytes or undefined SOCD directions.
 */
export function parseHigherKey(d: Uint8Array): HigherKeyConfig | null {
  const row = d[2] ?? 0;
  const col = d[3] ?? 0;
  switch (d[4]) {
    case HK_MODE.none:
      return { mode: 'none', row, col };
    case HK_MODE.dks:
      return {
        mode: 'dks', row, col,
        params: {
          kcs: [rd16(d, 5), rd16(d, 7), rd16(d, 9), rd16(d, 11)],
          trps: [d[13] ?? 0, d[14] ?? 0, d[15] ?? 0, d[16] ?? 0],
          dbs: [mmAt(d, 17), mmAt(d, 19)],
        },
      };
    case HK_MODE.mpt:
      return {
        mode: 'mpt', row, col,
        params: {
          kcs: [rd16(d, 5), rd16(d, 7), rd16(d, 9)],
          dbs: [mmAt(d, 11), mmAt(d, 13), mmAt(d, 15)],
        },
      };
    case HK_MODE.mt:
      return {
        mode: 'mt', row, col,
        params: { kcs: [rd16(d, 5), rd16(d, 7)], time: rd16(d, 9) },
      };
    case HK_MODE.tgl:
      return {
        mode: 'tgl', row, col,
        params: { kcs: rd16(d, 5), time: rd16(d, 7) },
      };
    case HK_MODE.end:
      return {
        mode: 'end', row, col,
        params: { kcs: [rd16(d, 5), rd16(d, 7)], delay: rd16(d, 9) },
      };
    case HK_MODE.socd: {
      const dir = socdDirectionFromByte(d[13] ?? 0xff);
      if (dir === null) return null;
      return {
        mode: 'socd', row, col,
        params: {
          row2: d[5] ?? 0,
          col2: d[6] ?? 0,
          kcs: [rd16(d, 7), rd16(d, 9)],
          delay: rd16(d, 11),
          direction: dir,
        },
      };
    }
    case HK_MODE.rs:
      return {
        mode: 'rs', row, col,
        params: {
          row2: d[5] ?? 0,
          col2: d[6] ?? 0,
          kcs: [rd16(d, 7), rd16(d, 9)],
          delay: rd16(d, 11),
        },
      };
    default:
      return null;
  }
}

// ── Category 7: Macro ──────────────────────────────────────────────────

/**
 * One macro action, packed into a u32 LE word: bit 31 = status flag
 * (1 = key-up/release — semantics unverified), bits 30..16 = delay
 * (≤ 32767, units unverified), bits 15..0 = HID keycode.
 */
export interface MacroAction {
  status: boolean;
  delay: number;
  keyCode: number;
}

/** u32 LE action word; throws on delay > 32767 or blacklisted keycode. */
export function macroActionEncode(a: MacroAction): number {
  if (!Number.isInteger(a.delay) || a.delay < 0 || a.delay > 32767) {
    throw new Error(`macro delay ${a.delay} exceeds maximum 32767`);
  }
  if (keycodeBlacklisted(a.keyCode)) {
    throw new Error(`macro keycode 0x${a.keyCode.toString(16).toUpperCase().padStart(4, '0')} is blacklisted`);
  }
  return ((a.status ? 1 : 0) << 31) | ((a.delay & 0x7fff) << 16) | (a.keyCode & 0xffff);
}

/** Inverse of `macroActionEncode`; accepts any u32. */
export function macroActionDecode(word: number): MacroAction {
  return {
    status: (word & 0x80000000) !== 0,
    delay: (word >>> 16) & 0x7fff,
    keyCode: word & 0xffff,
  };
}

/** Per-slot macro header (`07 01` read / `07 02` write). */
export interface MacroMode {
  macroId: number;
  valid: boolean;
  actNum: number;
  repNum: number;
  /** UI macro mode byte (0–3 observed; wire semantics unverified). */
  mode: number;
}

/** One page of macro action data: up to 15 actions per 64-byte report. */
export interface MacroPage {
  macroId: number;
  offset: number;
  actions: MacroAction[];
}

/** `02 0E 00` reply: macro storage capacity. */
export interface MacroSpaceInfo {
  macroCount: number;
  macroNumber: number;
}

/** `07 02` macro mode write report. */
export function macroModeReport(m: MacroMode): Uint8Array {
  const pkt = [CAT.macro, MACRO_CMD.modeWrite, m.macroId & 0xff, m.valid ? 1 : 0];
  const [a0, a1] = u16le(m.actNum);
  const [r0, r1] = u16le(m.repNum);
  pkt.push(a0, a1, r0, r1, m.mode & 0xff);
  return buildReport(pkt);
}

/** Parse a `07 01` mode reply. */
export function parseMacroModeReply(d: Uint8Array): MacroMode {
  return {
    macroId: d[2] ?? 0,
    valid: d[3] === 1,
    actNum: rd16(d, 4),
    repNum: rd16(d, 6),
    mode: d[8] ?? 0,
  };
}

/**
 * `07 04` write report for one page of macro actions. At most 15
 * actions per call; `offset` is the page index. Throws on >15 actions,
 * delays > 32767 or blacklisted keycodes. Hardware-unverified.
 */
export function macroDataReport(id: number, offset: number, actions: readonly MacroAction[]): Uint8Array {
  if (actions.length > MACRO_PAGE_ACTIONS) {
    throw new Error(`macro page holds at most ${MACRO_PAGE_ACTIONS} actions, got ${actions.length}`);
  }
  const pkt: number[] = [CAT.macro, MACRO_CMD.dataWrite, id & 0xff, offset & 0xff];
  for (const a of actions) {
    const w = macroActionEncode(a) >>> 0;
    pkt.push(w & 0xff, (w >>> 8) & 0xff, (w >>> 16) & 0xff, (w >>> 24) & 0xff);
  }
  return buildReport(pkt);
}

/**
 * Parse a `07 03`/`07 04` reply: `macroId` at 2, `offset` at 3, then up
 * to 15 u32-LE action words from byte 4.
 */
export function parseMacroPage(d: Uint8Array): MacroPage {
  const actions: MacroAction[] = [];
  for (let i = 0; i < MACRO_PAGE_ACTIONS; i++) {
    const o = 4 + 4 * i;
    actions.push(macroActionDecode(rd16(d, o) | (rd16(d, o + 2) << 16)));
  }
  return { macroId: d[2] ?? 0, offset: d[3] ?? 0, actions };
}

// ── Category 2: global writes & misc reads ─────────────────────────────

/** `02 03 02 <index>` profile switch. Restarts config; verify by read-back. */
export function profileSwitchReport(index: number): Uint8Array {
  return buildReport([CAT.global, GLOBAL_CMD.config, WRITE, index & 0xff]);
}

/** `02 04 02 <v>` OS mode write (0 Windows, 1 macOS). */
export function systemWriteReport(v: number): Uint8Array {
  return buildReport([CAT.global, GLOBAL_CMD.system, WRITE, v & 0xff]);
}

/** `02 05 02 <id>` polling-rate write — the keyboard restarts afterwards. */
export function reportRateWriteReport(id: number): Uint8Array {
  return buildReport([CAT.global, GLOBAL_CMD.reportRate, WRITE, id & 0xff]);
}

/** `02 0D 00 <lo> <hi>` lighting-sleep write (minutes, 0 = never). */
export function lightingSleepWriteReport(minutes: number): Uint8Array {
  const [lo, hi] = u16le(minutes);
  return buildReport([CAT.global, GLOBAL_CMD.lightingSleep, 0, lo, hi]);
}

/**
 * `02 06 00` start / `02 06 01` finish travel calibration.
 * Hardware-unverified beyond upstream code review; device operation.
 */
export function calibrationReport(start: boolean): Uint8Array {
  return buildReport([CAT.global, GLOBAL_CMD.calibration, start ? 0 : 1]);
}

// ── Lighting (category 5) ──────────────────────────────────────────────

export interface LightingBase {
  on: boolean;
  mode: number;
  /** 0–100. */
  brightness: number;
  /** 0–100. */
  speed: number;
  /** 0 forward / 1 backward. */
  direction: number;
  /** Palette index 0–7 (0 = multicolour on palette-using modes). */
  colorIndex: number;
}

/** Parse a `05 01 <zone> 00` effect reply. */
export function parseLighting(d: Uint8Array): LightingBase {
  return {
    on: (d[4] ?? 0) !== 0,
    mode: d[5] ?? 0,
    brightness: d[6] ?? 0,
    speed: d[7] ?? 0,
    direction: d[8] ?? 0,
    colorIndex: d[9] ?? 0,
  };
}

/** `05 02 <zone> 00 on mode bright speed dir color` write report. */
export function lightingWriteReport(area: number, l: LightingBase): Uint8Array {
  return buildReport([
    CAT.lighting, LIGHT_CMD.write, area & 0xff, LIGHT_CMD.whatEffect,
    l.on ? 1 : 0, l.mode & 0xff, l.brightness & 0xff, l.speed & 0xff,
    l.direction & 0xff, l.colorIndex & 0xff,
  ]);
}

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** Parse a `05 01 <zone> 01` palette reply: 8 entries wire order B,G,R,H. */
export function parsePalette(d: Uint8Array): Rgb[] {
  const out: Rgb[] = [];
  for (let i = 0; i < PALETTE_SIZE; i++) {
    out.push({
      b: d[4 + 4 * i] ?? 0,
      g: d[5 + 4 * i] ?? 0,
      r: d[6 + 4 * i] ?? 0,
    });
  }
  return out;
}

/** `05 02 <zone> 01` + 8 × (B, G, R, 0) palette write report. */
export function paletteWriteReport(area: number, colors: readonly Rgb[]): Uint8Array {
  const pkt: number[] = [CAT.lighting, LIGHT_CMD.write, area & 0xff, LIGHT_CMD.whatPalette];
  for (const c of colors.slice(0, PALETTE_SIZE)) {
    pkt.push((c.b ?? 0) & 0xff, (c.g ?? 0) & 0xff, (c.r ?? 0) & 0xff, 0);
  }
  return buildReport(pkt);
}

// ── Category 2 misc parsers ────────────────────────────────────────────

/** `02 05 00` reply: count at byte 3, rate ids from byte 4. */
export function parseReportRateList(d: Uint8Array): number[] {
  const n = Math.min(d[3] ?? 0, 16);
  return Array.from({ length: n }, (_, i) => d[4 + i] ?? 0);
}

export interface LightingArea {
  index: number;
  /** Number of effects the zone supports. */
  count: number;
  /** Matrix rows the zone covers (when reported). */
  rows: number;
  /** Matrix cols the zone covers (when reported). */
  cols: number;
}

/** `02 08 00` reply: zone count at byte 3, then `[index, effects, rows, cols]` per zone. */
export function parseLightingAreas(d: Uint8Array): LightingArea[] {
  const n = Math.min(d[3] ?? 0, 14);
  const out: LightingArea[] = [];
  for (let i = 0; i < n; i++) {
    const o = 4 + 4 * i;
    out.push({
      index: d[o] ?? 0,
      count: d[o + 1] ?? 0,
      rows: d[o + 2] ?? 0,
      cols: d[o + 3] ?? 0,
    });
  }
  return out;
}

// ── Debug helper ───────────────────────────────────────────────────────

export { hex as heHex };
