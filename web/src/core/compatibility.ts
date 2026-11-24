/**
 * Profile compatibility checks (vision §5 "compatibility validation").
 *
 * `canApplyProfile()` answers "may this profile JSON be applied to this
 * device?" before any write is attempted: protocol match, model match
 * and per-feature availability. It is read-only — it never touches a
 * device, it only reasons over `DeviceLike` + a capability map.
 */

import { getCapabilities, type CapabilityMap } from './capabilities.ts';
import { detectDevice, type DetectedDevice, type DeviceLike } from './device-model.ts';
import { describeFeature, isFeatureAvailable, isFeatureId } from './feature-registry.ts';

/** Subset of a profile JSON this check understands. */
export interface ProfileMeta {
  /** Protocol the profile was built for (`khub916`, `he-v2`, ...). */
  protocol?: string;
  /** Model name or catalog id the profile targets (e.g. "Mercury K1 PRO"). */
  model?: string;
  /** Vendor catalog model id (`916_*`). */
  catalogModel?: string;
  /** UI feature ids the profile requires (see feature-registry.ts). */
  features?: readonly string[];
}

export interface ApplyCheck {
  ok: boolean;
  reasons: string[];
}

/** Lowercase alphanumeric-only form for fuzzy-but-safe model compares. */
function normName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Model match: exact (normalised) or the detected name/catalog id
 * contains the requested name. Never matches on empty input.
 */
function modelMatches(requested: string, detected: DetectedDevice): boolean {
  const want = normName(requested);
  if (!want) return false;
  const candidates = [detected.model, detected.catalogModel].filter(
    (c): c is string => typeof c === 'string' && c.length > 0,
  );
  return candidates.some((c) => {
    const have = normName(c);
    return have === want || have.includes(want);
  });
}

/**
 * Validate `profile` against `device`. `device` is anything `DeviceLike`
 * (HIDDevice-ish, khub916 `DeviceInfo`, ...). Extra/unknown profile
 * fields are ignored — this checks what it knows, it does not schema-
 * validate the whole document.
 */
export function canApplyProfile(device: DeviceLike, profile: ProfileMeta): ApplyCheck {
  const reasons: string[] = [];
  const detected = detectDevice(device);

  if (profile.protocol && detected.protocol !== profile.protocol) {
    reasons.push(
      `profile targets protocol "${profile.protocol}" but this device speaks "${detected.protocol}"`,
    );
  }

  const modelReq = profile.model ?? profile.catalogModel;
  if (modelReq) {
    if (detected.model === null && detected.catalogModel === null) {
      reasons.push(`cannot confirm the model matches "${modelReq}" — device model unknown`);
    } else if (!modelMatches(modelReq, detected)) {
      reasons.push(
        `profile targets model "${modelReq}" but this device is "${detected.model ?? detected.catalogModel ?? 'unknown'}"`,
      );
    }
  }

  const capMap: CapabilityMap = getCapabilities(device);
  for (const fid of profile.features ?? []) {
    if (!isFeatureId(fid)) {
      reasons.push(`profile requires unknown feature "${fid}"`);
      continue;
    }
    if (!isFeatureAvailable(capMap, fid)) {
      reasons.push(`profile requires ${describeFeature(capMap, fid)}`);
    }
  }

  return { ok: reasons.length === 0, reasons };
}
