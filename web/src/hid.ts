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
 * - feature-report transact with 3 s timeout + 3 attempts and echo check;
 * - fire-and-forget config writes (cmd 3/4/5/6/10) followed by read-back
 *   verify — port of `Khub916::write_keymap` / `write_profile` /
 *   `write_macro_region` / `write_custom_light_colors` /
 *   `light::write_light_data`.
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
  keymapWritePacket,
  macroWritePacket,
  KEYMAP_ENTRIES,
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
import {
  ADV_BLOB_BYTES,
  advKeyWritePacket,
  keyConfigurationWritePacket,
  normalizeBlob,
} from './proto/advkey916.ts';
import { buildLightDataPacket, CUSTOM_LIGHT_SLOTS, type Rgb } from './proto/light.ts';

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
/** Settle delay between a fire-and-forget config write and its read-back. */
const WRITE_SETTLE_MS = 150;

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

  /** Macro region (cmd 133, ≤512 B) — raw; decode with proto/macro916.ts. */
  macroRegion(): Promise<Uint8Array> {
    return this.query(CMD.macroRead, 0x00, 0x00, 0x02).then(parseMacroRegion);
  }

  // ── Writes (port of `config_write` + the verified write_* methods) ──

  /**
   * Fire-and-forget config write. The vendor JS never reads a reply to
   * write commands — only `sendFeatureReport` — so this bypasses the
   * echo-checked `transact`. A transport error poisons the session.
   */
  private async configWrite(pkt: Uint8Array): Promise<void> {
    if (this.poisoned) {
      throw new Error('khub916 session poisoned by an earlier transport/framing error; reconnect the device');
    }
    if (pkt.length !== FEATURE_PAYLOAD_BYTES) {
      throw new Error(`khub916 packet must be ${FEATURE_PAYLOAD_BYTES} bytes, got ${pkt.length}`);
    }
    try {
      await this.device.sendFeatureReport(this.reportId, pkt);
      // Let the firmware commit before the verify read (vendor spacing is
      // ~30 ms/command, debounce 100 ms; Rust uses 150 ms).
      await new Promise((r) => setTimeout(r, WRITE_SETTLE_MS));
    } catch (e) {
      this.poisoned = true;
      throw new Error(`khub916 config write failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /**
   * Write the keymap (cmd 3, tags 248/1). `layer`/`system` pack into
   * `arg = layer & 3 | (system & 1) << 2`. `values` is the u32 BE key
   * list — at most 128; shorter lists are zero padded exactly like the
   * vendor `formatKeyPayload` (see `keymapWritePacket`).
   *
   * Verify: re-reads cmd 131 with the same arg; every slot must match
   * (missing tail entries count as 0). A mismatch throws — the session
   * is *not* poisoned (the write landed, the data differs).
   */
  async writeKeymap(layer: number, system: number, values: readonly number[]): Promise<WriteOutcome> {
    const arg = (layer & 3) | ((system & 1) << 2);
    await this.configWrite(keymapWritePacket(layer, system, values));
    const back = await this.keyValues(arg);
    if (back.length > KEYMAP_ENTRIES) {
      throw new Error(`khub916 keymap read-back has ${back.length} entries (> ${KEYMAP_ENTRIES})`);
    }
    // Compare zero-padded to the full 128-slot table: devices report
    // only their populated slot count (K1 Pro: 126).
    const matches = Array.from({ length: KEYMAP_ENTRIES }, (_, i) =>
      (values[i] ?? 0) === (back[i] ?? 0),
    ).every(Boolean);
    if (!matches) {
      throw new Error('khub916 keymap write not verified: read-back differs');
    }
    return { command: CMD.keymapWrite, verified: true };
  }

  /**
   * Write the macro region (cmd 5, tags `len&0xFF`/0 — vendor header
   * `[5,0,0,1,0,len,0]`). `data` is the assembled region (see
   * `buildMacroRegion`); it is zero-padded to the vendor's fixed
   * 512-byte payload exactly like `setKeyBoardMacroIndependent` /
   * `deleteKeyBoardMacroKey`.
   *
   * Verify: cmd-133 read-back, zero-padded/truncated to 512 bytes, must
   * equal the sent payload. A mismatch throws without poisoning.
   */
  async writeMacroRegion(data: Uint8Array): Promise<WriteOutcome> {
    if (data.length === 0 || data.length > 512) {
      throw new Error(`khub916 macro write needs 1..=512 bytes, got ${data.length}`);
    }
    const payload = new Uint8Array(512);
    payload.set(data);
    await this.configWrite(macroWritePacket(data));
    const back = await this.macroRegion();
    // Compare zero-padded to the fixed 512-byte region: the read may
    // return fewer bytes (trailing zeros trimmed) — pad it the same way.
    const backPad = new Uint8Array(512);
    backPad.set(back.subarray(0, 512));
    if (!bytesEqual(backPad, payload)) {
      throw new Error('khub916 macro write not verified: read-back differs');
    }
    return { command: CMD.macroWrite, verified: true };
  }

  /**
   * Write the profile/config blob (cmd 4, tags 128/0). `profile` is the
   * ~128-byte blob as returned by `profile()`, optionally modified via
   * `withLightMode` (proto/light.ts) or `profileWithSleepSeconds`
   * (proto/khub916.ts). Verify: cmd-132 read-back must
   * equal the sent bytes.
   */
  async writeProfile(profile: Uint8Array): Promise<WriteOutcome> {
    if (profile.length === 0 || profile.length > FEATURE_PAYLOAD_BYTES - HEADER_LEN) {
      throw new Error(`khub916 profile write: bad length ${profile.length}`);
    }
    await this.configWrite(buildPacket(CMD.profileWrite, 0x00, 0x80, 0x00, profile));
    const back = await this.profile();
    if (!bytesEqual(back.raw, profile)) {
      throw new Error('khub916 profile write not verified: read-back differs');
    }
    return { command: CMD.profileWrite, verified: true };
  }

  /**
   * Write custom light colours (cmd 6, tags 122/1). `colors` must have
   * exactly 126 entries; the 378-byte payload is `[R×126][G×126][B×126]`.
   * Verify: cmd-134 read-back planes must reproduce the same colours.
   */
  async writeCustomLightColors(colors: readonly Rgb[]): Promise<WriteOutcome> {
    if (colors.length !== CUSTOM_LIGHT_SLOTS) {
      throw new Error(
        `khub916 custom light write needs exactly ${CUSTOM_LIGHT_SLOTS} colours, got ${colors.length}`,
      );
    }
    const payload = new Uint8Array(CUSTOM_LIGHT_SLOTS * 3);
    colors.forEach((c, i) => {
      payload[i] = c.r & 0xff;
      payload[CUSTOM_LIGHT_SLOTS + i] = c.g & 0xff;
      payload[2 * CUSTOM_LIGHT_SLOTS + i] = c.b & 0xff;
    });
    await this.configWrite(buildPacket(CMD.customLightWrite, 0x00, 0x7a, 0x01, payload));
    const back = await this.customLightColors();
    const matches =
      back.length === colors.length &&
      back.every((b, i) => b.r === colors[i]?.r && b.g === colors[i]?.g && b.b === colors[i]?.b);
    if (!matches) {
      throw new Error('khub916 custom light write not verified: read-back differs');
    }
    return { command: CMD.customLightWrite, verified: true };
  }

  /**
   * Write the per-mode light colour blob (wired cmd 10). `data` is the
   * full ~483-byte blob from `lightColorData()`, typically modified via
   * `withGroupColor`. Verify: cmd-138 read-back must reproduce `data` as
   * a prefix (the device may pad/normalise the tail).
   */
  async writeLightData(data: Uint8Array): Promise<WriteOutcome> {
    await this.configWrite(buildLightDataPacket(data));
    const back = await this.lightColorData();
    if (back.length < data.length || !bytesEqual(back.slice(0, data.length), data)) {
      throw new Error('khub916 light data write not verified: read-back differs');
    }
    return { command: CMD.lightDataWrite, verified: true };
  }

  // ── Advanced keys (SOCD/MT/TGL — proto/advkey916.ts) ─────────────────

  /**
   * Keymap values on the vendor `sendKeyConfiguration` channel:
   * cmd 131 arg 0, tags 0/2 — the read counterpart of
   * `writeKeyConfiguration` (distinct from `keyValues`' 248/1
   * layer/system channel, which is what the adv planners read via
   * `getKeyboardKeys({layer:0})`). The vendor JS never reads this
   * channel back; this read exists so writes can be verified.
   */
  async keyConfiguration(): Promise<number[]> {
    return parseKeyValues(await this.query(CMD.keymapRead, 0x00, 0x00, 0x02));
  }

  /**
   * SOCD/MT/TGL history blob (cmd 146, tags 0/2 — vendor
   * `getKeyboardAdvancedKey`). Returns the raw payload; use
   * `normalizeBlob` (proto/advkey916.ts) for a fixed 512-byte view.
   */
  async advKeyConfig(): Promise<Uint8Array> {
    return this.query(CMD.advKeyRead, 0x00, 0x00, 0x02);
  }

  /**
   * Write the 512-byte SOCD/MT/TGL history blob (cmd 18, tags 0/2 —
   * vendor `sendAdvanKeyHistory`). Fire-and-forget like every config
   * write.
   *
   * Read-back verify is **best-effort**: on K1 Pro (live-tested) cmd-146
   * returns unrelated firmware-memory pages for ~60 s after the write
   * within the same session, and the write itself did not persist on
   * that unit. This polls ~2.2 s and reports `verified: false` rather
   * than throwing, so callers can surface "sent, unconfirmed" honestly.
   * Treat cmd 18 as code-verified, persistence unconfirmed (see
   * docs/advkeys-schema.md).
   */
  async writeAdvKeyConfig(blob: Uint8Array): Promise<WriteOutcome> {
    if (blob.length !== ADV_BLOB_BYTES) {
      throw new Error(`khub916 adv-key write needs exactly ${ADV_BLOB_BYTES} bytes, got ${blob.length}`);
    }
    await this.configWrite(advKeyWritePacket(blob));
    const want = normalizeBlob(blob);
    let back = await this.advKeyConfig();
    for (let attempt = 0; attempt <= 10; attempt++) {
      if (bytesEqual(normalizeBlob(back), want)) {
        return { command: CMD.advKeyWrite, verified: true };
      }
      if (attempt === 10) break;
      await sleep(200);
      back = await this.advKeyConfig();
    }
    // Best-effort only: the write was sent vendor-identically.
    return { command: CMD.advKeyWrite, verified: false };
  }

  /**
   * Write the keymap through the vendor `sendKeyConfiguration` header
   * `[3,0,0,1,0,0,2]` — arg 0, tags 0/2 — used by every adv-key set
   * operation (distinct from `writeKeymap`'s 248/1 header). `values` is
   * the u32 BE key list (≤128, zero-padded, `5A A5` end marker).
   *
   * Verify: cmd-131 read-back on the same 0/2 channel
   * (`keyConfiguration`) must match zero-padded to 128 entries. Same
   * async-commit caveat as the cmd-18 history write: poll briefly
   * before declaring a mismatch; a mismatch throws without poisoning.
   */
  async writeKeyConfiguration(values: readonly number[]): Promise<WriteOutcome> {
    if (values.length === 0 || values.length > KEYMAP_ENTRIES) {
      throw new Error(
        `khub916 key configuration write needs 1..=${KEYMAP_ENTRIES} values, got ${values.length}`,
      );
    }
    await this.configWrite(keyConfigurationWritePacket(values));
    // Expected read-back = `values` zero-padded to KEYMAP_ENTRIES with
    // the same `5A A5` trailer the write payload carries (bytes
    // 510/511 land inside u32 index 127). Port of advkey.rs.
    const want = new Array<number>(KEYMAP_ENTRIES).fill(0);
    values.forEach((v, i) => {
      want[i] = v >>> 0;
    });
    want[KEYMAP_ENTRIES - 1] = ((want[KEYMAP_ENTRIES - 1] ?? 0) & 0xffff_0000 | 0x5aa5) >>> 0;
    for (let attempt = 0; attempt <= 10; attempt++) {
      const back = await this.keyConfiguration();
      if (back.length > KEYMAP_ENTRIES) {
        throw new Error(
          `khub916 key configuration read-back has ${back.length} entries (> ${KEYMAP_ENTRIES})`,
        );
      }
      const matches = want.every((w, i) => w === (back[i] ?? 0));
      if (matches) {
        return { command: CMD.keymapWrite, verified: true };
      }
      if (attempt === 10) break;
      await sleep(50);
    }
    throw new Error('khub916 key configuration write not verified: read-back differs');
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

/** Result of a verified write (port of proto `WriteOutcome`). */
export interface WriteOutcome {
  command: number;
  verified: boolean;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

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
