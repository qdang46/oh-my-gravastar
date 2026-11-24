/**
 * Feature registry — maps UI feature ids onto capability keys.
 *
 * Pages ask "is feature X available on the connected device?" via
 * `isFeatureAvailable()` and render explanations via `describeFeature()`.
 * The registry is the single place UI ids are bound to the capability
 * matrix keys from `capabilities.ts`.
 */

import type { Capability, CapabilityKey, CapabilityMap, CapabilityState } from './capabilities.ts';

export interface FeatureDef {
  /** Capability-matrix key this feature depends on. */
  capability: CapabilityKey;
  /** Short user-facing label. */
  label: string;
}

/**
 * UI feature ids → capability binding. Ids are the stable contract for
 * pages; renaming a capability key is a breaking change here.
 */
export const FEATURE_REGISTRY = {
  'keymap-editor': { capability: 'keymap', label: 'Keymap editor' },
  'layer-manager': { capability: 'layers', label: 'Key layers' },
  'macro-studio': { capability: 'macro', label: 'Macro studio' },
  'per-key-rgb': { capability: 'per_key_rgb', label: 'Per-key RGB' },
  'lighting-studio': { capability: 'lighting_effects', label: 'Lighting studio' },
  'adv-keys': { capability: 'adv_keys', label: 'Advanced keys (SOCD/MT/TGL)' },
  'music-reactive': { capability: 'music_reactive', label: 'Music-reactive lighting' },
  actuation: { capability: 'actuation', label: 'Actuation point' },
  'rapid-trigger': { capability: 'rapid_trigger', label: 'Rapid trigger' },
  deadzone: { capability: 'deadzone', label: 'Deadzone' },
  'dks-mpt': { capability: 'dks_mpt', label: 'DKS / MPT' },
  'live-travel': { capability: 'live_travel', label: 'Live travel' },
  calibration: { capability: 'calibration', label: 'Calibration' },
  polling: { capability: 'polling', label: 'Polling rate' },
  wireless: { capability: 'wireless', label: 'Wireless' },
  screen: { capability: 'screen', label: 'Device screen' },
} as const satisfies Record<string, FeatureDef>;

export type FeatureId = keyof typeof FEATURE_REGISTRY;

export function isFeatureId(id: string): id is FeatureId {
  return id in FEATURE_REGISTRY;
}

/**
 * States that allow the UI to offer the feature. `unverified` stays
 * usable (the codec exists) but `describeFeature` surfaces the caveat;
 * `experimental` is opt-in visible.
 */
const AVAILABLE_STATES: ReadonlySet<CapabilityState> = new Set([
  'supported',
  'experimental',
  'unverified',
]);

function capabilityFor(capMap: CapabilityMap, featureId: FeatureId): Capability | undefined {
  const def = FEATURE_REGISTRY[featureId];
  return def ? capMap[def.capability] : undefined;
}

/**
 * True when the feature may be shown as usable for this device.
 * Unknown feature ids and missing capability entries return false.
 */
export function isFeatureAvailable(capMap: CapabilityMap, featureId: string): boolean {
  if (!isFeatureId(featureId)) return false;
  const cap = capabilityFor(capMap, featureId);
  return cap !== undefined && AVAILABLE_STATES.has(cap.state);
}

const VERIFIED_PHRASE: Record<NonNullable<Capability['verified']>, string> = {
  live: 'verified on real hardware',
  code: 'verified in code — not yet tested on hardware',
  synthetic: 'verified with synthetic tests only',
  none: 'not yet verified',
};

/**
 * One-line user-facing explanation of a feature's availability.
 * Always returns a string; unknown ids get a generic answer.
 */
export function describeFeature(capMap: CapabilityMap, featureId: string): string {
  const label = isFeatureId(featureId) ? FEATURE_REGISTRY[featureId].label : featureId;
  if (!isFeatureId(featureId)) {
    return `${label}: unknown feature.`;
  }
  const cap = capabilityFor(capMap, featureId);
  if (!cap) {
    return `${label}: unknown — this device did not report the capability.`;
  }
  const verified = cap.verified ? ` (${VERIFIED_PHRASE[cap.verified]})` : '';
  switch (cap.state) {
    case 'supported':
      return `${label}: supported${verified}.`;
    case 'experimental':
      return `${label}: experimental — use with care${verified}.`;
    case 'unverified':
      return `${label}: available, but not fully verified${cap.reason ? ` — ${cap.reason}` : ''}.`;
    case 'unsupported-hardware':
      return `${label}: not available — ${cap.reason ?? 'this hardware does not support it'}.`;
    case 'unsupported-firmware':
      return `${label}: not available on this firmware — ${cap.reason ?? 'firmware does not support it'}.`;
    case 'protocol-unknown':
      return `${label}: unknown — ${cap.reason ?? 'the device protocol has not been verified for this'}.`;
  }
}
