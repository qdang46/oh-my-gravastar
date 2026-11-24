/**
 * Device context assembly — `docs/AGENT-ARCHITECTURE.md` §2.
 *
 * `buildDeviceContext()` reads everything the planner/validator needs to
 * reason about the CONNECTED device: identity + protocol (core/),
 * firmware/power/profile state, capability map, physical layout, current
 * keymap summary, lighting state, macro inventory and snapshot
 * availability. This is the data source behind "Explain my keyboard"
 * (AGENT-ARCHITECTURE §5).
 *
 * Reads run SEQUENTIALLY and each is individually guarded: a failed read
 * degrades that section to absent + a `warnings[]` entry rather than
 * failing the whole context (mirrors `state.ts::loadSnapshot`). No
 * serials/tokens are ever placed in the context (SAFETY-SPEC §7).
 */

import {
  detectDevice,
  getCapabilities,
  type CapabilityMap,
  type DetectedDevice,
  type DeviceLike,
  type ProtocolKind,
  type VerifiedLevel,
} from '../core/index.ts';
import {
  decodeKeyValue,
  keyValueLabel,
  type DeviceInfo,
  type KeyValue,
  type PowerInfo,
  type ProfileInfo,
} from '../proto/khub916.ts';
import { K1_PRO_BLOCKS, K1_PRO_LAYOUT_MODELS, type KeyBlock } from '../k1pro-layout.ts';
import {
  decodeLightState,
  groupColor,
  lightModeInfo,
  type Rgb,
} from '../proto/light.ts';
import {
  MACRO_REGION_BYTES,
  macroFreeSpace,
  padMacroRegion,
  parseMacroRegion,
} from '../proto/macro916.ts';
import type { SnapshotMeta, SnapshotStore } from '../safety/snapshots.ts';

// ── Read-side session contract ─────────────────────────────────────────

/**
 * Minimal read surface — satisfied structurally by `Khub916Session`
 * (hid.ts) and by mocks in tests. Every method optional: a session that
 * cannot answer a read simply leaves that context section empty.
 */
export interface DeviceReader {
  deviceInfo?(): Promise<DeviceInfo>;
  power?(): Promise<PowerInfo>;
  profile?(): Promise<ProfileInfo>;
  keyValues?(arg: number): Promise<number[]>;
  keymap?(arg: number): Promise<{ value: number; kv: KeyValue; label: string }[]>;
  customLightColors?(): Promise<readonly { r: number; g: number; b: number }[]>;
  lightColorData?(): Promise<Uint8Array>;
  macroRegion?(): Promise<Uint8Array>;
  advKeyConfig?(): Promise<Uint8Array>;
  /** Vendor 0/2 arg-0 keymap channel (adv-key planner input). */
  keyConfiguration?(): Promise<number[]>;
}

// ── Context shape ──────────────────────────────────────────────────────

export interface ContextDevice {
  model: string | null;
  protocol: ProtocolKind;
  catalogModel: string | null;
  transport: 'wired' | 'wireless' | null;
  vid?: number;
  pid?: number;
  /**
   * Ready-made `omg --device` / plan-`device` selector (`"0xVID:0xPID"`)
   * when both ids are known — WebHID exposes no stable device path, so
   * vid:pid is the most precise selector a web plan can carry. Absent
   * when the identity is incomplete (e.g. khub916 sessions report no
   * vid/pid — use `"auto"` or the device `uuid`).
   */
  selector?: string;
  /** Weakest verification level across the capability map. */
  verification: VerifiedLevel;
}

export interface KeymapArgSummary {
  /** Packed keymap arg: layer | system<<2 (0–7). */
  arg: number;
  /** Raw u32 values as read (device-reported length). */
  values: number[];
  /** Non-zero slots with decoded labels. */
  entries: { index: number; value: number; label: string }[];
}

export interface ContextLighting {
  mode: number;
  modeName?: string;
  speed: number;
  brightness: number;
  colorModel: number;
  /** Group colour for the active mode (cmd-138 blob), when decodable. */
  color?: Rgb;
}

export interface ContextMacro {
  name: string;
  steps: number;
}

export interface DeviceContext {
  device: ContextDevice;
  firmware?: { version: string };
  state: {
    battery?: number;
    lightingMode?: number;
    sleepSeconds?: number | null;
    macroEntries?: number;
    macroFreeBytes?: number;
  };
  capabilities: CapabilityMap;
  /** Physical layout (K1 Pro blocks) when the model is known. */
  layout?: readonly KeyBlock[];
  keymaps: KeymapArgSummary[];
  lighting?: ContextLighting;
  macros: ContextMacro[];
  /** SnapshotStore listing, when a store was supplied. */
  snapshots?: SnapshotMeta[];
  /** Human-readable notes about reads that failed or data that is partial. */
  warnings: string[];
}

// ── Assembly ───────────────────────────────────────────────────────────

const KEYMAP_ARG_COUNT = 4; // layers 0–3, system bit 0 (state.ts convention)

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Weakest verification across the map — honest overall level. */
function weakestVerification(caps: CapabilityMap): VerifiedLevel {
  const order: VerifiedLevel[] = ['none', 'synthetic', 'code', 'live'];
  let worst: VerifiedLevel = 'live';
  for (const c of Object.values(caps)) {
    const v = c?.verified ?? 'none';
    if (order.indexOf(v) < order.indexOf(worst)) worst = v;
  }
  return worst;
}

async function readGuarded<T>(
  warnings: string[],
  what: string,
  fn: () => Promise<T>,
): Promise<T | undefined> {
  try {
    return await fn();
  } catch (e) {
    warnings.push(`${what}: ${msg(e)}`);
    return undefined;
  }
}

/**
 * Build the context for the session's device. `opts.device` carries the
 * HID-side identity (vendorId/productId/productName) when the caller has
 * it; `opts.snapshots` enables the snapshot-availability listing.
 */
export async function buildDeviceContext(
  session: DeviceReader,
  opts: { device?: DeviceLike; snapshots?: SnapshotStore } = {},
): Promise<DeviceContext> {
  const warnings: string[] = [];

  // ── Identity + firmware (cmd 130) ──────────────────────────────────
  const info = await readGuarded(warnings, 'device info', () =>
    session.deviceInfo ? session.deviceInfo() : Promise.reject(new Error('no deviceInfo read')),
  );

  const like: DeviceLike = {
    ...(opts.device ?? {}),
    ...(info
      ? {
          uuid: info.uuid,
          catalogModel: info.catalogModel,
          catalogName: info.catalogName,
          screenSize: info.screenSize,
        }
      : {}),
  };
  const detected: DetectedDevice = detectDevice(like);
  const caps = getCapabilities(like);

  const device: ContextDevice = {
    model: detected.model ?? info?.catalogName ?? opts.device?.productName ?? null,
    protocol: detected.protocol,
    catalogModel: detected.catalogModel ?? info?.catalogModel ?? null,
    transport: detected.transport,
    ...(opts.device?.vendorId !== undefined ? { vid: opts.device.vendorId } : {}),
    ...(opts.device?.productId !== undefined ? { pid: opts.device.productId } : {}),
    ...(opts.device?.vendorId !== undefined && opts.device?.productId !== undefined
      ? {
          selector: `0x${opts.device.vendorId.toString(16).padStart(4, '0')}:0x${opts.device.productId
            .toString(16)
            .padStart(4, '0')}`,
        }
      : {}),
    verification: weakestVerification(caps),
  };

  const ctx: DeviceContext = {
    device,
    ...(info ? { firmware: { version: info.versionHex } } : {}),
    state: {},
    capabilities: caps,
    keymaps: [],
    macros: [],
    warnings,
  };

  // Physical layout — only for catalog models with a ported table.
  if (detected.catalogModel && K1_PRO_LAYOUT_MODELS.includes(detected.catalogModel)) {
    ctx.layout = K1_PRO_BLOCKS;
  }

  // ── Power / profile / lighting ─────────────────────────────────────
  const power = await readGuarded(warnings, 'power', () =>
    session.power ? session.power() : Promise.reject(new Error('no power read')),
  );
  if (power) ctx.state.battery = power.percent;

  const profile = await readGuarded(warnings, 'profile', () =>
    session.profile ? session.profile() : Promise.reject(new Error('no profile read')),
  );
  if (profile) {
    ctx.state.sleepSeconds = profile.sleepSeconds;
    const light = decodeLightState(profile.raw);
    if (light) {
      const info2 = lightModeInfo(light.mode);
      ctx.state.lightingMode = light.mode;
      ctx.lighting = {
        mode: light.mode,
        ...(info2 ? { modeName: info2.name } : {}),
        speed: light.speed,
        brightness: light.brightness,
        colorModel: light.colorModel,
      };
    } else {
      ctx.state.lightingMode = profile.lightMode ?? undefined;
      warnings.push('lighting: profile blob has no decodable light state');
    }
  }

  const lightData = await readGuarded(warnings, 'light data', () =>
    session.lightColorData
      ? session.lightColorData()
      : Promise.reject(new Error('no lightColorData read')),
  );
  if (lightData && ctx.lighting) {
    const color = groupColor(lightData, ctx.lighting.mode);
    if (color) ctx.lighting.color = color;
  }

  // ── Macro inventory ────────────────────────────────────────────────
  const macroRegion = await readGuarded(warnings, 'macro region', () =>
    session.macroRegion
      ? session.macroRegion()
      : Promise.reject(new Error('no macroRegion read')),
  );
  if (macroRegion) {
    try {
      const entries = parseMacroRegion(macroRegion);
      ctx.macros = entries.map((e) => ({ name: e.name, steps: e.steps.length }));
      ctx.state.macroEntries = entries.length;
      // Free space is measured on the fixed 512-byte wire region: the
      // cmd-133 read may be trimmed, so zero-pad before scanning for the
      // vendor's ≥4-zero run (macro916.ts::macroFreeSpace).
      const regionView =
        macroRegion.length >= MACRO_REGION_BYTES
          ? macroRegion
          : padMacroRegion(macroRegion);
      ctx.state.macroFreeBytes = macroFreeSpace(regionView);
    } catch (e) {
      warnings.push(`macro region decode: ${msg(e)}`);
    }
  }

  // ── Keymap summaries (layers 0–3, system 0) ────────────────────────
  for (let arg = 0; arg < KEYMAP_ARG_COUNT; arg++) {
    const summary = await readKeymapArg(session, arg, warnings);
    if (summary) ctx.keymaps.push(summary);
  }

  // ── Snapshot availability ──────────────────────────────────────────
  if (opts.snapshots) {
    try {
      ctx.snapshots = opts.snapshots.list();
    } catch (e) {
      warnings.push(`snapshot list: ${msg(e)}`);
    }
  }

  return ctx;
}

async function readKeymapArg(
  session: DeviceReader,
  arg: number,
  warnings: string[],
): Promise<KeymapArgSummary | undefined> {
  try {
    if (session.keymap) {
      const decoded = await session.keymap(arg);
      const values = decoded.map((e) => e.value >>> 0);
      return {
        arg,
        values,
        entries: decoded
          .map((e, i) => ({ index: i, value: e.value >>> 0, label: e.label }))
          .filter((e) => e.value !== 0),
      };
    }
    if (session.keyValues) {
      const values = (await session.keyValues(arg)).map((v) => v >>> 0);
      return {
        arg,
        values,
        entries: values
          .map((value, index) => ({ index, value, label: keyValueLabel(decodeKeyValue(value)) }))
          .filter((e) => e.value !== 0),
      };
    }
  } catch (e) {
    warnings.push(`keymap arg ${arg}: ${msg(e)}`);
  }
  return undefined;
}
