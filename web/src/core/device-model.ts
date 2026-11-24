/**
 * Device identity detection for the capability layer.
 *
 * Ports the classification logic of `crates/hid/src/devices.rs`
 * (`classify()`) to the web app's `DeviceInfo`-ish inputs:
 *
 * - khub916 wired/wireless VID:PID tables mirror `hid.ts`
 *   (`KHUB916_WIRED` / `KHUB916_WIRELESS` / `kindOf`) — duplicated here
 *   rather than imported because `hid.ts` uses constructor parameter
 *   properties, which Node's strip-only TS mode (the smoke harness)
 *   cannot parse. Keep the tables in sync with `hid.ts`;
 * - HE "v2" keyboard, Compx mouse and SparkPlayJoy tables are ported
 *   from `devices.rs` (same upstream constants);
 * - a khub916 `DeviceInfo` (cmd-130 parse: `uuid` + `catalogModel` /
 *   `catalogName`) classifies as `khub916` even without VID/PID, since
 *   only that protocol reports a device UUID.
 *
 * `usagePage`/`usage` are optional: when absent they do not veto a
 * VID/PID match (a bare `HIDDevice` picker result carries no collection
 * info). When present they must match, mirroring `classify()`.
 */

import { catalogLookup } from '../proto/khub916.ts';

/** Protocol families the UI knows how to reason about. */
export type ProtocolKind = 'khub916' | 'he-v2' | 'compx' | 'sparkplayjoy' | 'unknown';

export type KhubTransport = 'wired' | 'wireless';

/**
 * Minimal device description accepted by detection. Satisfied by:
 * - a khub916 `DeviceInfo` (`uuid`, `catalogModel`, `catalogName`,
 *   `screenSize` — `vendorId`/`productId` simply absent),
 * - an `HIDDevice`-like object (`vendorId`, `productId`, `productName`),
 * - any subset of the fields above.
 */
export interface DeviceLike {
  vendorId?: number;
  productId?: number;
  productName?: string | null;
  /** HID usage page of the interface that speaks the protocol. */
  usagePage?: number;
  /** HID usage (SparkPlayJoy requires usage 1). */
  usage?: number;
  /** khub916 device UUID (`0x…` hex) from cmd 130. */
  uuid?: string | null;
  /** Vendor catalog model id (`916_*`), when known. */
  catalogModel?: string | null;
  /** Vendor catalog display name, when known. */
  catalogName?: string | null;
  /** khub916 screen-size code; 0/absent = no screen. */
  screenSize?: number;
}

export interface DetectedDevice {
  protocol: ProtocolKind;
  /** Human-facing model name when known (catalog name or product string). */
  model: string | null;
  /** Vendor catalog model id (`916_*`), when known. */
  catalogModel: string | null;
  /** khub916 transport; null for other protocols. */
  transport: KhubTransport | null;
  /** Short explanation of how the device was classified. */
  detail: string;
}

// ── Identity tables (port of crates/hid/src/devices.rs) ───────────────
// khub916 tables are copied verbatim from hid.ts (`KHUB916_WIRED` /
// `KHUB916_WIRELESS`) — see the module doc for why they are not imported.

/** Wired `916` VID/PID pairs (VID 0x258A = 9610, VID 0x379A = 14234). */
const KHUB916_WIRED: readonly (readonly [number, number])[] = [
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
const KHUB916_WIRELESS: readonly (readonly [number, number])[] = [
  [0x3554, 0xfa09],
  [0x258a, 0x0150],
  [0x379a, 0xa002],
  [0x379a, 0xa009],
  [0x379a, 0xa006],
] as const;

function khub916KindOf(vid: number, pid: number): KhubTransport | null {
  if (KHUB916_WIRED.some(([v, p]) => v === vid && p === pid)) return 'wired';
  if (KHUB916_WIRELESS.some(([v, p]) => v === vid && p === pid)) return 'wireless';
  return null;
}

/** HE keyboard "v2" — vendor ids the official driver routes to v2. */
const HE_VIDS: readonly number[] = [0x1ca6, 0x31e3];
const HE_USAGE_PAGE = 0xffb0;
/** HE product ids — decimal literals as upstream (`devices.rs`). */
const HE_PIDS: readonly number[] = [
  11272, 11273, 11282, 11275, 11276, 11288, 11289, 11296, 11297, 11290, 11291, 11292,
  11293, 11274, 11278, 11277, 4896, 11283, 11284, 11305, 11306, 11300, 11298,
];

/** SparkPlayJoy 6x21 analog — matched on usage page + usage only. */
const SPARKPLAYJOY_USAGE_PAGE = 0xffa0;
const SPARKPLAYJOY_USAGE = 1;

/** Compx mice (orbit-gravastar mouse protocol). */
const MOUSE_VID = 0x3554;
const MOUSE_PIDS: readonly number[] = [0xf54b, 0xf575, 0xf548, 0xf577, 0xf576, 0xf549];
const MOUSE_USAGE_PAGE = 0xff02;

/**
 * khub916 "screen" model (`devices.rs` `KHUB916_SCREEN`): the only
 * khub916 VID/PID known to carry a display.
 */
export const KHUB916_SCREEN_VID = 0x258a;
export const KHUB916_SCREEN_PID = 0x01b4;

function pageMatches(actual: number | undefined, expected: number): boolean {
  return actual === undefined || actual === expected;
}

function isHeKeyboard(vid: number, pid: number, usagePage?: number): boolean {
  return HE_VIDS.includes(vid) && HE_PIDS.includes(pid) && pageMatches(usagePage, HE_USAGE_PAGE);
}

function isCompxMouse(vid: number, pid: number, usagePage?: number): boolean {
  return (
    vid === MOUSE_VID && MOUSE_PIDS.includes(pid) && pageMatches(usagePage, MOUSE_USAGE_PAGE)
  );
}

function isSparkPlayJoy(usagePage?: number, usage?: number): boolean {
  // No VID/PID anchor: the usage page must be present and exact, or every
  // unknown device would classify as SparkPlayJoy.
  return usagePage === SPARKPLAYJOY_USAGE_PAGE && (usage === undefined || usage === SPARKPLAYJOY_USAGE);
}

/** khub916 wired-collection minimum usage page (spec §1 / devices.rs). */
const KHUB916_USAGE_PAGE_MIN = 0xff00;

/**
 * The screen-carrying khub916 model (`devices.rs` `KHUB916_SCREEN`,
 * checked after the wired table — 0x258A:0x01B4 is not in it).
 */
function isKhub916ScreenModel(info: DeviceLike): boolean {
  return (
    info.vendorId === KHUB916_SCREEN_VID &&
    info.productId === KHUB916_SCREEN_PID &&
    (info.usagePage === undefined || info.usagePage >= KHUB916_USAGE_PAGE_MIN)
  );
}

/**
 * Classify a `DeviceLike` into a protocol + model. Never throws; unknown
 * inputs return `protocol: 'unknown'`.
 */
export function detectDevice(info: DeviceLike): DetectedDevice {
  const unknown: DetectedDevice = {
    protocol: 'unknown',
    model: info.productName ?? null,
    catalogModel: null,
    transport: null,
    detail: 'unrecognised device — no matching GravaStar identity',
  };

  const { vendorId: vid, productId: pid } = info;
  const vidPid = vid !== undefined && pid !== undefined;
  const kind = vidPid ? khub916KindOf(vid, pid) : null;
  const screenModel = isKhub916ScreenModel(info);
  const transport: KhubTransport | null =
    kind ?? (screenModel ? 'wired' : null);

  // khub916 device-info UUID is protocol-unique: only cmd 130 reports one.
  // VID/PID still refine the transport when both are present.
  if (info.uuid) {
    const entry = catalogLookup(info.uuid);
    return {
      protocol: 'khub916',
      model: entry?.name ?? info.catalogName ?? info.productName ?? null,
      catalogModel: entry?.model ?? info.catalogModel ?? null,
      transport,
      detail: entry
        ? `khub916 device UUID ${info.uuid} (catalog: ${entry.model})`
        : `khub916 device UUID ${info.uuid}`,
    };
  }

  if (vid !== undefined && pid !== undefined) {
    // khub916 first: 0x3554:0xfa09 (wireless dongle) shares VID 0x3554
    // with the Compx mice but is a keyboard transport.
    if (kind !== null) {
      return {
        protocol: 'khub916',
        model: info.catalogName ?? info.productName ?? null,
        catalogModel: info.catalogModel ?? null,
        transport: kind,
        detail: `khub916 ${kind} VID:PID ${vid.toString(16)}:${pid.toString(16)}`,
      };
    }
    if (screenModel) {
      return {
        protocol: 'khub916',
        model: info.catalogName ?? info.productName ?? 'GravaStar screen keyboard',
        catalogModel: info.catalogModel ?? null,
        transport: 'wired',
        detail: `khub916 screen model VID:PID ${vid.toString(16)}:${pid.toString(16)}`,
      };
    }
    if (isHeKeyboard(vid, pid, info.usagePage)) {
      return {
        protocol: 'he-v2',
        model: info.productName ?? null,
        catalogModel: null,
        transport: null,
        detail: `HE v2 keyboard VID:PID ${vid.toString(16)}:${pid.toString(16)}`,
      };
    }
    if (isCompxMouse(vid, pid, info.usagePage)) {
      return {
        protocol: 'compx',
        model: info.productName ?? null,
        catalogModel: null,
        transport: null,
        detail: `Compx mouse VID:PID ${vid.toString(16)}:${pid.toString(16)}`,
      };
    }
  }

  if (isSparkPlayJoy(info.usagePage, info.usage)) {
    return {
      protocol: 'sparkplayjoy',
      model: info.productName ?? null,
      catalogModel: null,
      transport: null,
      detail: 'SparkPlayJoy 6x21 analog (usage page 0xFFA0, usage 1)',
    };
  }

  return unknown;
}

/** True when the khub916 device is the known screen-carrying model. */
export function hasScreen(info: DeviceLike): boolean {
  if ((info.screenSize ?? 0) > 0) return true;
  return info.vendorId === KHUB916_SCREEN_VID && info.productId === KHUB916_SCREEN_PID;
}
