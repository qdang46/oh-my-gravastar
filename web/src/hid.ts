/**
 * WebHID transport for the khub916 wired protocol.
 *
 * Mirrors the vendor web driver's `Ht` engine class and the Rust
 * `omg_proto_khub916::Khub916` session:
 *
 * - device filter tables from `docs/research/khub-webapp/index.js`
 *   (`916` wired + `916_wireLess`), same as `crates/hid/src/devices.rs`;
 * - collection pick: wired = `featureReports>0 && inputReports>0 &&
 *   usagePage >= 0xFF00`; wireless = `outputReports>0 && inputReports>0`
 *   (spec §1);
 * - `reportId = featureReports[0].reportId` with a 6 → 1..32 probe fallback
 *   like `probe_report_id` (only the read-only cmd-130 query is ever sent);
 * - feature-report transact with 3 s timeout + 3 attempts and echo check.
 *
 * READ-ONLY MVP: only query commands are exposed. No write opcodes exist
 * in this module.
 */

import {
  CMD,
  FEATURE_PAYLOAD_BYTES,
  HEADER_LEN,
  buildPacket,
  echoMatches,
  parseCustomLightColors,
  parseDeviceInfo,
  parseKeyValues,
  parseLightColorData,
  parseMacroRegion,
  parsePower,
  parseProfile,
  queryPacket,
  responsePayload,
  type DeviceInfo,
  type KeyValue,
  type LightColor,
  type PowerInfo,
  type ProfileInfo,
} from './proto/khub916.ts';
import { decodeKeyValue, keyValueLabel } from './proto/khub916.ts';

// ── Device identity tables (spec §1, `Ts` table) ───────────────────────

/** Wired `916` VID/PID pairs (VID 0x258A = 9610, VID 0x379A = 14234). */
export const KHUB916_WIRED: readonly (readonly [number, number])[] = [
  [0x258a, 0x010c], // K1 Pro — "Gaming Keyboard" / "BY Tech"
  [0x258a, 0x019d],
  [0x258a, 0x0297],
  [0x258a, 0x02a5],
  [0x258a, 0x0296],
  [0x258a, 0x02dd],
  [0x258a, 0x02e9],
  [0x258a, 0x0293],
  [0x258a, 0x0294],
  [0x258a, 0x0295],
  [0x379a, 0xa001],
  [0x379a, 0xa000],
  [0x379a, 0xa004],
  [0x379a, 0xa008],
  [0x379a, 0xa005],
] as const;

/** Wireless `916_wireLess` VID/PID pairs (duplicates removed). */
export const KHUB916_WIRELESS: readonly (readonly [number, number])[] = [
  [0x3554, 0xfa09],
  [0x258a, 0x0150],
  [0x379a, 0xa002],
  [0x379a, 0xa009],
  [0x379a, 0xa006],
] as const;

/** Wired vendor collection minimum usage page (0xFF00). */
export const KHUB916_USAGE_PAGE_MIN = 0xff00;

export type KhubKind = 'wired' | 'wireless';

export function kindOf(vid: number, pid: number): KhubKind | null {
  if (KHUB916_WIRED.some(([v, p]) => v === vid && p === pid)) return 'wired';
  if (KHUB916_WIRELESS.some(([v, p]) => v === vid && p === pid)) return 'wireless';
  return null;
}

/** One HIDDeviceFilter per VID:PID pair (requestDevice ORs the list). */
export function deviceFilters(): HIDDeviceFilter[] {
  const filters: HIDDeviceFilter[] = [];
  for (const [vendorId, productId] of [...KHUB916_WIRED, ...KHUB916_WIRELESS]) {
    filters.push({ vendorId, productId });
  }
  return filters;
}

// ── Collection selection (spec §1) ─────────────────────────────────────

interface CollectionMatch {
  collection: HIDCollection;
  kind: KhubKind;
  depth: number;
}

function* walkCollections(c: HIDCollection, depth: number): Generator<[HIDCollection, number]> {
  yield [c, depth];
  for (const child of c.children) yield* walkCollections(child, depth + 1);
}

/**
 * Find the khub916 collection on an opened device. Wired predicate:
 * `featureReports>0 && inputReports>0 && usagePage>=0xFF00`. Wireless
 * predicate: `outputReports>0 && inputReports>0` (no usagePage check).
 * Prefers the shallowest match, wired over wireless on ties.
 */
export function pickCollection(device: HIDDevice): CollectionMatch | null {
  const matches: CollectionMatch[] = [];
  for (const top of device.collections) {
    for (const [c, depth] of walkCollections(top, 0)) {
      const kind = kindOf(device.vendorId, device.productId);
      if (kind === 'wired') {
        if (
          c.featureReports.length > 0 &&
          c.inputReports.length > 0 &&
          c.usagePage >= KHUB916_USAGE_PAGE_MIN
        ) {
          matches.push({ collection: c, kind, depth });
        }
      } else if (kind === 'wireless') {
        if (c.outputReports.length > 0 && c.inputReports.length > 0) {
          matches.push({ collection: c, kind, depth });
        }
      }
    }
  }
  if (matches.length === 0) return null;
  matches.sort((a, b) => a.depth - b.depth || (a.kind === 'wired' ? -1 : 1));
  return matches[0] ?? null;
}

// ── Session ────────────────────────────────────────────────────────────

const TRANSPORT_TIMEOUT_MS = 3000;
const MAX_ATTEMPTS = 3;

/**
 * One open khub916 wired session. Feature-report reads are async; a
 * transport or framing error poisons the session (close and reopen).
 */
export class Khub916Session {
  private poisoned = false;

  constructor(
    private readonly device: HIDDevice,
    private readonly reportId: number,
  ) {}

  get isPoisoned(): boolean {
    return this.poisoned;
  }

  /**
   * Send one 519-byte feature report and return the response payload
   * (bytes after the echoed 7-byte header). Retries on no-answer / echo
   * mismatch; transport errors poison the session.
   */
  private async transact(pkt: Uint8Array): Promise<Uint8Array> {
    if (this.poisoned) {
      throw new Error('khub916 session poisoned by an earlier transport/framing error; reconnect the device');
    }
    if (pkt.length !== FEATURE_PAYLOAD_BYTES) {
      throw new Error(`khub916 packet must be ${FEATURE_PAYLOAD_BYTES} bytes, got ${pkt.length}`);
    }
    let lastErr = new Error('khub916: no attempt made');
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      try {
        await this.device.sendFeatureReport(this.reportId, pkt);
        const resp = await this.receiveWithTimeout();
        // Chrome may or may not include the report-id byte at offset 0;
        // the vendor JS unconditionally drops it (`shift()`).
        const bytes = stripReportId(resp, this.reportId);
        if (bytes.length < HEADER_LEN) {
          lastErr = new Error(`khub916 short response: ${bytes.length} bytes`);
          continue;
        }
        if (!echoMatches(pkt, bytes)) {
          lastErr = new Error(
            `khub916 echo mismatch: sent [${hex(bytes.slice(0, HEADER_LEN))}] expected [${hex(pkt.slice(0, HEADER_LEN))}]`,
          );
          continue;
        }
        return responsePayload(bytes);
      } catch (e) {
        // Timeout / device errors are retryable; sendFeatureReport
        // rejections also land here.
        lastErr = e instanceof Error ? e : new Error(String(e));
      }
    }
    this.poisoned = true;
    throw new Error(`khub916 command failed after ${MAX_ATTEMPTS} attempts: ${lastErr.message}`);
  }

  /** receiveFeatureReport raced against our own timeout (spec support varies). */
  private async receiveWithTimeout(): Promise<Uint8Array> {
    const dv = await Promise.race([
      this.device.receiveFeatureReport(this.reportId),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('khub916: no answer (timeout)')), TRANSPORT_TIMEOUT_MS),
      ),
    ]);
    return new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength);
  }

  /** Header-only query helper. */
  private async query(cmd: number, arg: number, tagA: number, tagB: number): Promise<Uint8Array> {
    return this.transact(queryPacket(cmd, arg, tagA, tagB));
  }

  // ── Reads (all live-verified query commands, spec §5/§6) ─────────────

  /** Device info (cmd 130): UUID, firmware version, screen geometry. */
  deviceInfo(): Promise<DeviceInfo> {
    return this.query(CMD.deviceInfo, 0x01, 0x0a, 0x00).then(parseDeviceInfo);
  }

  /** Keymap u32 values for one layer/system arg (cmd 131). */
  async keyValues(arg: number): Promise<number[]> {
    return parseKeyValues(await this.query(CMD.keymapRead, arg, 0xf8, 0x01));
  }

  /** Keymap decoded to labelled entries (see proto/khub916.ts). */
  async keymap(arg: number): Promise<{ value: number; kv: KeyValue; label: string }[]> {
    const values = await this.keyValues(arg);
    return values.map((value) => {
      const kv = decodeKeyValue(value);
      return { value, kv, label: keyValueLabel(kv) };
    });
  }

  /** Profile/config blob (cmd 132, ~128 B). */
  profile(): Promise<ProfileInfo> {
    return this.query(CMD.profileRead, 0x00, 0x80, 0x00).then(parseProfile);
  }

  /** Power/battery (cmd 135): `[level, flags]`. */
  power(): Promise<PowerInfo> {
    return this.query(CMD.powerRead, 0x00, 0x02, 0x00).then(parsePower);
  }

  /** Custom light colours (cmd 134): 126 RGB entries. */
  customLightColors(): Promise<LightColor[]> {
    return this.query(CMD.customLightRead, 0x00, 0x7a, 0x01).then(parseCustomLightColors);
  }

  /** Per-mode light colour/effect blob (cmd 138, ~480 B) — raw. */
  lightColorData(): Promise<Uint8Array> {
    return this.query(CMD.lightDataRead, 0x00, 0xe3, 0x01).then(parseLightColorData);
  }

  /** Macro region (cmd 133, ≤512 B) — raw, parsing stubbed. */
  macroRegion(): Promise<Uint8Array> {
    return this.query(CMD.macroRead, 0x00, 0x00, 0x02).then(parseMacroRegion);
  }
}

// ── Helpers ────────────────────────────────────────────────────────────

function hex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, '0').toUpperCase()).join(' ');
}

/**
 * Drop the report-id byte when present. Chrome's receiveFeatureReport may
 * include it as byte 0 for numbered reports; the vendor JS always `shift()`s
 * it. Only strip when it equals the report id we asked for.
 */
function stripReportId(bytes: Uint8Array, reportId: number): Uint8Array {
  if (bytes.length > 0 && bytes[0] === reportId) {
    return bytes.slice(1);
  }
  return bytes;
}

/**
 * Probe the feature-report id like `probe_report_id`: try the collection's
 * declared feature report ids first (vendor uses `featureReports[0]`), then
 * 6, then 1..32. Only the read-only device-info query (cmd 130) is sent.
 */
export async function probeReportId(
  device: HIDDevice,
  collection: HIDCollection,
): Promise<number> {
  const declared = collection.featureReports.map((r) => r.reportId);
  const candidates = [...new Set([...declared, 6, ...range(1, 32).filter((i) => i !== 6)])];
  const pkt = queryPacket(CMD.deviceInfo, 0x01, 0x0a, 0x00);
  let lastErr = 'no report id answered';
  for (const id of candidates) {
    try {
      await device.sendFeatureReport(id, pkt);
      const dv = await Promise.race([
        device.receiveFeatureReport(id),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('timeout')), TRANSPORT_TIMEOUT_MS),
        ),
      ]);
      const bytes = stripReportId(new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength), id);
      if (bytes.length >= HEADER_LEN + 9 && echoMatches(pkt, bytes)) {
        return id;
      }
      lastErr = `report id ${id}: bad echo/short response (${bytes.length} bytes)`;
    } catch (e) {
      lastErr = `report id ${id}: ${e instanceof Error ? e.message : String(e)}`;
    }
  }
  throw new Error(`khub916 report id probe failed: ${lastErr}`);
}

function range(from: number, to: number): number[] {
  const out: number[] = [];
  for (let i = from; i <= to; i++) out.push(i);
  return out;
}

// ── High-level connect flow ────────────────────────────────────────────

export interface ConnectedKhub {
  device: HIDDevice;
  kind: KhubKind;
  collection: HIDCollection;
  reportId: number;
  session: Khub916Session;
}

/**
 * Open a picked HIDDevice as a khub916 wired session. Throws on wireless
 * devices (transport not implemented) and on missing collections.
 */
export async function openKhub916(device: HIDDevice): Promise<ConnectedKhub> {
  const match = pickCollection(device);
  if (!match) {
    throw new Error('No khub916 vendor collection found on this device');
  }
  if (match.kind === 'wireless') {
    throw new Error('916_wireLess (2.4 GHz dongle) transport is not implemented yet');
  }
  await device.open();
  try {
    const reportId = await probeReportId(device, match.collection);
    return {
      device,
      kind: match.kind,
      collection: match.collection,
      reportId,
      session: new Khub916Session(device, reportId),
    };
  } catch (e) {
    await device.close().catch(() => {});
    throw e;
  }
}

/**
 * Prompt the user to pick a khub916 device. Returns null when the user
 * cancels the picker.
 */
export async function requestKhubDevice(): Promise<HIDDevice | null> {
  if (!('hid' in navigator)) return null;
  const devices = await navigator.hid.requestDevice({ filters: deviceFilters() });
  return devices[0] ?? null;
}

/** Re-open a previously granted device (permissions persist per origin). */
export async function getRememberedDevices(): Promise<HIDDevice[]> {
  if (!('hid' in navigator)) return [];
  return navigator.hid.getDevices();
}

export function formatVidPid(device: HIDDevice): string {
  return `VID ${device.vendorId.toString(16).toUpperCase().padStart(4, '0')}:PID ${device.productId
    .toString(16)
    .toUpperCase()
    .padStart(4, '0')}`;
}

export { buildPacket };
