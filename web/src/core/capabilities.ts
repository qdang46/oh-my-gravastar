/**
 * Capability registry — the "what can THIS device actually do" layer.
 *
 * Implements the capability-matrix direction from
 * `docs/vision-full-custom.md` §5: one `CapabilityMap` per detected
 * protocol, consumed by the feature registry (`feature-registry.ts`)
 * and profile compatibility checks (`compatibility.ts`).
 *
 * Verification levels follow the repo convention (code-verified /
 * synthetic-tested / live-verified):
 * - `live`      — exercised against real hardware (K1 Pro).
 * - `code`      — implemented and unit-tested, no live device yet.
 * - `synthetic` — codec tested with synthetic packets only.
 * - `none`      — not verified at all.
 */

import { CUSTOM_LIGHT_SLOTS } from '../proto/light.ts';
import { detectDevice, hasScreen, type DeviceLike, type ProtocolKind } from './device-model.ts';

// ── Types ──────────────────────────────────────────────────────────────

export type CapabilityState =
  | 'supported'
  | 'unsupported-hardware'
  | 'unsupported-firmware'
  | 'protocol-unknown'
  | 'experimental'
  | 'unverified';

export type VerifiedLevel = 'live' | 'code' | 'synthetic' | 'none';

/** Feature keys of the capability matrix (vision §5). */
export type CapabilityKey =
  | 'keymap'
  | 'layers'
  | 'macro'
  | 'per_key_rgb'
  | 'lighting_effects'
  | 'adv_keys'
  | 'music_reactive'
  | 'actuation'
  | 'rapid_trigger'
  | 'deadzone'
  | 'dks_mpt'
  | 'live_travel'
  | 'calibration'
  | 'polling'
  | 'wireless'
  | 'screen';

export const CAPABILITY_KEYS: readonly CapabilityKey[] = [
  'keymap',
  'layers',
  'macro',
  'per_key_rgb',
  'lighting_effects',
  'adv_keys',
  'music_reactive',
  'actuation',
  'rapid_trigger',
  'deadzone',
  'dks_mpt',
  'live_travel',
  'calibration',
  'polling',
  'wireless',
  'screen',
];

export interface Capability {
  state: CapabilityState;
  /** Why the feature is unavailable / caveated, when not obvious. */
  reason?: string;
  verified?: VerifiedLevel;
  /** Number of keymap layers, for `layers`/`keymap`. */
  layers?: number;
  /** Extra structured limits (slot counts, mode counts, ranges). */
  limits?: Record<string, number | string>;
}

/** Keyed by `CapabilityKey`; every builder fills all keys. */
export type CapabilityMap = Partial<Record<CapabilityKey, Capability>>;

// ── Builders ───────────────────────────────────────────────────────────

function cap(state: CapabilityState, opts: Partial<Capability> = {}): Capability {
  return { state, ...opts };
}

const MECHANICAL_REASON = 'mechanical-switch keyboard — no per-key analog travel sensing';

function mechanicalCaps(): CapabilityMap {
  const c = cap('unsupported-hardware', { reason: MECHANICAL_REASON, verified: 'none' });
  return {
    actuation: c,
    rapid_trigger: c,
    deadzone: c,
    dks_mpt: c,
    live_travel: c,
    calibration: c,
  };
}

/** khub916 (K1 / K98 series) — wired transport live-verified on K1 Pro. */
function khub916Capabilities(info: DeviceLike): CapabilityMap {
  const screen = hasScreen(info)
    ? cap('supported', {
        verified: 'code',
        reason: 'screen geometry decoded from cmd-130; dashboard UI not built yet',
      })
    : cap('unsupported-hardware', { reason: 'this model has no screen', verified: 'none' });

  return {
    keymap: cap('supported', { verified: 'live', layers: 4 }),
    layers: cap('supported', { verified: 'live', layers: 4 }),
    macro: cap('supported', { verified: 'live' }),
    per_key_rgb: cap('supported', {
      verified: 'live',
      limits: { colour_slots: CUSTOM_LIGHT_SLOTS },
    }),
    lighting_effects: cap('supported', { verified: 'live' }),
    // Codec + UI exist, but the cmd-18 history write did not persist on
    // the live-tested K1 Pro — flag, don't claim "stable" (vision §4.2).
    adv_keys: cap('unverified', {
      reason: 'cmd-18 history persistence unconfirmed on K1 Pro',
      verified: 'code',
    }),
    music_reactive: cap('supported', { verified: 'live' }),
    ...mechanicalCaps(),
    polling: cap('unverified', {
      reason: 'polling-rate reporting not confirmed on khub916 firmware',
      verified: 'none',
    }),
    // The wireless `916_wireLess` transport is not implemented in the
    // web app yet; capability stays unknown until the dongle is verified.
    wireless: cap('protocol-unknown', {
      reason: 'wireless dongle transport not yet verified',
      verified: 'none',
    }),
    screen,
  };
}

/** HE keyboard "v2" — implemented upstream; no live hardware here. */
function heV2Capabilities(): CapabilityMap {
  return {
    keymap: cap('supported', { verified: 'code' }),
    layers: cap('unsupported-firmware', {
      reason: 'key-layer count is firmware-dependent and not yet enumerated',
      verified: 'code',
    }),
    macro: cap('unverified', {
      reason: 'some macro writes are unverified upstream',
      verified: 'code',
    }),
    per_key_rgb: cap('supported', { verified: 'code' }),
    lighting_effects: cap('supported', {
      verified: 'code',
      reason: 'zone-based lighting',
    }),
    adv_keys: cap('supported', { verified: 'code' }),
    music_reactive: cap('protocol-unknown', {
      reason: 'music-reactive lighting not documented for HE v2',
      verified: 'none',
    }),
    actuation: cap('supported', { verified: 'code' }),
    rapid_trigger: cap('supported', { verified: 'code' }),
    deadzone: cap('supported', { verified: 'code' }),
    dks_mpt: cap('supported', { verified: 'code' }),
    live_travel: cap('supported', { verified: 'code' }),
    calibration: cap('supported', { verified: 'code' }),
    polling: cap('supported', { verified: 'code' }),
    wireless: cap('protocol-unknown', {
      reason: 'wireless transport not implemented for HE v2',
      verified: 'none',
    }),
    screen: cap('protocol-unknown', {
      reason: 'screen support varies by HE model',
      verified: 'none',
    }),
  };
}

/** Compx mouse — a pointing device, not a keyboard. */
function compxCapabilities(): CapabilityMap {
  const c = cap('unsupported-hardware', {
    reason: 'Compx mouse — not a keyboard',
    verified: 'none',
  });
  const map: CapabilityMap = {};
  for (const key of CAPABILITY_KEYS) map[key] = c;
  return map;
}

/** SparkPlayJoy — read-only analog capture protocol. */
function sparkPlayJoyCapabilities(): CapabilityMap {
  const c = cap('unsupported-firmware', {
    reason: 'SparkPlayJoy protocol is read-only (analog capture)',
    verified: 'code',
  });
  const map: CapabilityMap = {};
  for (const key of CAPABILITY_KEYS) map[key] = c;
  return map;
}

/** Fallback for unrecognised devices: nothing is claimed. */
function unknownCapabilities(): CapabilityMap {
  const c = cap('protocol-unknown', {
    reason: 'unrecognised device — no protocol driver',
    verified: 'none',
  });
  const map: CapabilityMap = {};
  for (const key of CAPABILITY_KEYS) map[key] = c;
  return map;
}

function capabilitiesForProtocol(protocol: ProtocolKind, info: DeviceLike): CapabilityMap {
  switch (protocol) {
    case 'khub916':
      return khub916Capabilities(info);
    case 'he-v2':
      return heV2Capabilities();
    case 'compx':
      return compxCapabilities();
    case 'sparkplayjoy':
      return sparkPlayJoyCapabilities();
    default:
      return unknownCapabilities();
  }
}

// ── Public API ─────────────────────────────────────────────────────────

/**
 * Build the capability map for a device. Accepts anything `DeviceLike`:
 * an HIDDevice-ish `{vendorId, productId, ...}`, a khub916 `DeviceInfo`
 * (`uuid`, `catalogName`, `screenSize`), or a partial descriptor.
 */
export function getCapabilities(info: DeviceLike): CapabilityMap {
  const detected = detectDevice(info);
  return capabilitiesForProtocol(detected.protocol, info);
}

/** Detected protocol for a device — convenience wrapper. */
export function protocolOf(info: DeviceLike): ProtocolKind {
  return detectDevice(info).protocol;
}
