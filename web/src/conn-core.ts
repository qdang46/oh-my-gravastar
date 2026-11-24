/**
 * Connection-lifecycle core — DOM-free, unit-testable helpers for the
 * remembered-device / auto-reconnect flow (bead grd).
 *
 * Everything here is pure or storage-injectable so `scripts/smoke-conn.ts`
 * can exercise it under plain Node. The HID event wiring lives in
 * `device-events.ts`; the session logic in `state/connection.ts`.
 *
 * Privacy (AGENTS.md §Safety 5): a device serial number is used ONLY for
 * identity matching and is never displayed or logged. It is stored in
 * localStorage solely so the app can tell two identical VID:PID units
 * apart across sessions.
 */

/** Minimal shape shared by HIDDevice and test doubles. */
export interface DeviceLike {
  vendorId: number;
  productId: number;
  serialNumber?: string | null;
}

/** Persisted identity of the last-used keyboard. */
export interface DeviceIdentity {
  vendorId: number;
  productId: number;
  /** null when the descriptor exposes no usable serial. */
  serialNumber: string | null;
}

export function deviceIdentity(d: DeviceLike): DeviceIdentity {
  const serial =
    typeof d.serialNumber === 'string' && d.serialNumber.length > 0
      ? d.serialNumber
      : null;
  return { vendorId: d.vendorId, productId: d.productId, serialNumber: serial };
}

/**
 * Identity equality. When BOTH sides expose a serial it must match —
 * two identical VID:PID boards are different keyboards. When either
 * side lacks a serial we fall back to VID:PID (better a possibly-wrong
 * match than never auto-connecting).
 */
export function sameDevice(identity: DeviceIdentity, device: DeviceLike): boolean {
  return identityScore(identity, device) > 0;
}

/**
 * Match score used for ordering: 2 = VID:PID + serial exact, 1 = VID:PID
 * only (serial missing on one side), 0 = no match — including a known
 * serial mismatch, which means a *different* physical unit.
 */
export function identityScore(identity: DeviceIdentity, device: DeviceLike): number {
  const d = deviceIdentity(device);
  if (identity.vendorId !== d.vendorId || identity.productId !== d.productId) return 0;
  if (identity.serialNumber !== null && d.serialNumber !== null) {
    return identity.serialNumber === d.serialNumber ? 2 : 0;
  }
  return 1;
}

/**
 * Stable-sort candidates so the last-used device is tried first —
 * matters when several authorised GravaStar keyboards are plugged in.
 * Devices scoring 0 keep their relative order at the tail.
 */
export function orderByLastUsed<T extends DeviceLike>(
  devices: readonly T[],
  last: DeviceIdentity | null,
): T[] {
  if (!last || devices.length < 2) return [...devices];
  return devices
    .map((d, i) => ({ d, i, score: identityScore(last, d) }))
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .map((x) => x.d);
}

// ── Persistence ────────────────────────────────────────────────────────

/** Minimal Storage surface (localStorage satisfies it; tests inject a Map). */
export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const LAST_DEVICE_STORAGE_KEY = 'omg.lastDevice.v1';

function defaultStorage(): KeyValueStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export function loadLastDevice(
  storage: KeyValueStorage | null = defaultStorage(),
): DeviceIdentity | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(LAST_DEVICE_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<DeviceIdentity>;
    if (typeof parsed.vendorId !== 'number' || typeof parsed.productId !== 'number') {
      return null;
    }
    return {
      vendorId: parsed.vendorId,
      productId: parsed.productId,
      serialNumber:
        typeof parsed.serialNumber === 'string' && parsed.serialNumber.length > 0
          ? parsed.serialNumber
          : null,
    };
  } catch {
    return null;
  }
}

export function saveLastDevice(
  identity: DeviceIdentity,
  storage: KeyValueStorage | null = defaultStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(LAST_DEVICE_STORAGE_KEY, JSON.stringify(identity));
  } catch {
    /* storage full / private mode — remembering is best-effort */
  }
}
