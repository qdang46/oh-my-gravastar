/**
 * Node smoke test for `src/core/` — capability detection, feature
 * registry and profile compatibility. Run:
 *   npm run smoke   (node >= 22.18, native TS type stripping)
 */

declare const process: { exit(code?: number): never };

import {
  CAPABILITY_KEYS,
  getCapabilities,
  protocolOf,
  type CapabilityKey,
} from '../src/core/capabilities.ts';
import { detectDevice, hasScreen, KHUB916_SCREEN_PID, KHUB916_SCREEN_VID } from '../src/core/device-model.ts';
import {
  describeFeature,
  FEATURE_REGISTRY,
  isFeatureAvailable,
  isFeatureId,
  type FeatureId,
} from '../src/core/feature-registry.ts';
import { canApplyProfile } from '../src/core/compatibility.ts';

let failures = 0;
function check(name: string, cond: boolean, extra = ''): void {
  if (cond) {
    console.log(`  ok  ${name}`);
  } else {
    failures++;
    console.error(`FAIL  ${name} ${extra}`);
  }
}

const K1_PRO = {
  vendorId: 0x258a,
  productId: 0x010c,
  productName: 'Gaming Keyboard',
  uuid: '0x030000000197',
  catalogModel: '916_K1_PRO',
  catalogName: 'GravaStar Mercury K1 PRO',
  screenSize: 0,
};

// ── device-model detection ─────────────────────────────────────────────

{
  const d = detectDevice(K1_PRO);
  check('K1 Pro protocol', d.protocol === 'khub916', d.protocol);
  check('K1 Pro transport', d.transport === 'wired');
  check('K1 Pro model', d.model === 'GravaStar Mercury K1 PRO', String(d.model));
  check('K1 Pro catalog', d.catalogModel === '916_K1_PRO');

  // DeviceInfo-ish: uuid + catalog fields, no VID/PID.
  const byUuid = detectDevice({ uuid: '0x030000000197' });
  check('uuid-only → khub916', byUuid.protocol === 'khub916');
  check('uuid-only → catalog model', byUuid.catalogModel === '916_K1_PRO');
  check('uuid-only → catalog name', byUuid.model === 'GravaStar Mercury K1 PRO');

  const he = detectDevice({ vendorId: 0x1ca6, productId: 11272, usagePage: 0xffb0 });
  check('HE v2 protocol', he.protocol === 'he-v2', he.protocol);

  const heNoPage = detectDevice({ vendorId: 0x1ca6, productId: 11272 });
  check('HE v2 without usagePage still matches', heNoPage.protocol === 'he-v2');

  const wrongPage = detectDevice({ vendorId: 0x1ca6, productId: 11272, usagePage: 0xff02 });
  check('HE v2 wrong usagePage → unknown', wrongPage.protocol === 'unknown');

  const wireless = detectDevice({ vendorId: 0x3554, productId: 0xfa09 });
  check('khub916 wireless dongle', wireless.protocol === 'khub916' && wireless.transport === 'wireless');

  const compx = detectDevice({ vendorId: 0x3554, productId: 0xf54b, usagePage: 0xff02 });
  check('Compx mouse', compx.protocol === 'compx', compx.protocol);

  const spj = detectDevice({ usagePage: 0xffa0, usage: 1 });
  check('SparkPlayJoy', spj.protocol === 'sparkplayjoy', spj.protocol);

  const unknown = detectDevice({ vendorId: 0x1234, productId: 0x5678 });
  check('unknown device', unknown.protocol === 'unknown');

  check('hasScreen K1 Pro', !hasScreen(K1_PRO));
  check(
    'hasScreen screen model',
    hasScreen({ vendorId: KHUB916_SCREEN_VID, productId: KHUB916_SCREEN_PID }),
  );
  check('hasScreen via screenSize', hasScreen({ screenSize: 4 }));
}

// ── khub916 capability map ─────────────────────────────────────────────

{
  const caps = getCapabilities(K1_PRO);
  const st = (k: CapabilityKey) => caps[k]?.state;
  const ver = (k: CapabilityKey) => caps[k]?.verified;

  check('khub916 keymap supported+live', st('keymap') === 'supported' && ver('keymap') === 'live');
  check('khub916 keymap layers=4', caps.keymap?.layers === 4);
  check('khub916 layers supported', st('layers') === 'supported' && caps.layers?.layers === 4);
  check('khub916 macro live', st('macro') === 'supported' && ver('macro') === 'live');
  check('khub916 per_key_rgb live', st('per_key_rgb') === 'supported' && ver('per_key_rgb') === 'live');
  check('khub916 lighting live', st('lighting_effects') === 'supported' && ver('lighting_effects') === 'live');
  check('khub916 music live', st('music_reactive') === 'supported' && ver('music_reactive') === 'live');

  // Mechanical-switch features must NOT be supported.
  for (const k of ['actuation', 'rapid_trigger', 'deadzone', 'dks_mpt', 'live_travel', 'calibration'] as const) {
    check(`khub916 ${k} unsupported-hardware`, st(k) === 'unsupported-hardware', String(st(k)));
  }
  check(
    'khub916 mechanical reason',
    caps.actuation?.reason?.includes('mechanical') === true,
  );

  // adv_keys: codec+UI exist but cmd-18 persistence unconfirmed.
  check('khub916 adv_keys unverified', st('adv_keys') === 'unverified', String(st('adv_keys')));
  check('khub916 adv_keys reason', caps.adv_keys?.reason?.includes('cmd-18') === true);
  check('khub916 adv_keys verified=code', ver('adv_keys') === 'code');

  check('khub916 polling unverified', st('polling') === 'unverified');
  check('khub916 wireless protocol-unknown', st('wireless') === 'protocol-unknown');
  check('khub916 K1 Pro screen unsupported', st('screen') === 'unsupported-hardware');

  // All 16 matrix keys populated.
  check(
    'khub916 map covers all keys',
    CAPABILITY_KEYS.every((k) => caps[k] !== undefined),
  );

  // Screen model variant.
  const screenCaps = getCapabilities({
    vendorId: KHUB916_SCREEN_VID,
    productId: KHUB916_SCREEN_PID,
    usagePage: 0xff00,
  });
  check('screen model screen supported', screenCaps.screen?.state === 'supported');
}

// ── he-v2 capability map ───────────────────────────────────────────────

{
  const caps = getCapabilities({ vendorId: 0x1ca6, productId: 11272, usagePage: 0xffb0 });
  const st = (k: CapabilityKey) => caps[k]?.state;
  const ver = (k: CapabilityKey) => caps[k]?.verified;

  check('he-v2 keymap supported+code', st('keymap') === 'supported' && ver('keymap') === 'code');
  check('he-v2 actuation supported+code', st('actuation') === 'supported' && ver('actuation') === 'code');
  check('he-v2 RT supported', st('rapid_trigger') === 'supported');
  check('he-v2 deadzone supported', st('deadzone') === 'supported');
  check('he-v2 dks_mpt supported', st('dks_mpt') === 'supported');
  check('he-v2 live_travel supported', st('live_travel') === 'supported');
  check('he-v2 calibration supported', st('calibration') === 'supported');
  check('he-v2 polling supported', st('polling') === 'supported');
  check('he-v2 adv_keys supported', st('adv_keys') === 'supported');
  check('he-v2 layers firmware-dependent', st('layers') === 'unsupported-firmware');
  check('he-v2 macro unverified', st('macro') === 'unverified');
  check(
    'he-v2 nothing live-verified',
    CAPABILITY_KEYS.every((k) => caps[k]?.verified !== 'live'),
  );
}

// ── compx / sparkplayjoy / unknown ─────────────────────────────────────

{
  const compx = getCapabilities({ vendorId: 0x3554, productId: 0xf54b, usagePage: 0xff02 });
  check('compx keymap unsupported', compx.keymap?.state === 'unsupported-hardware');
  check('compx actuation unsupported', compx.actuation?.state === 'unsupported-hardware');

  const spj = getCapabilities({ usagePage: 0xffa0, usage: 1 });
  check('sparkplayjoy read-only', spj.keymap?.state === 'unsupported-firmware');
  check('sparkplayjoy reason mentions read-only', spj.keymap?.reason?.includes('read-only') === true);

  const unk = getCapabilities({ vendorId: 0x1234, productId: 0x5678 });
  check(
    'unknown device: everything protocol-unknown',
    CAPABILITY_KEYS.every((k) => unk[k]?.state === 'protocol-unknown'),
  );
  check('unknown protocolOf', protocolOf({ vendorId: 0x1234, productId: 0x5678 }) === 'unknown');
}

// ── feature registry ───────────────────────────────────────────────────

{
  const caps = getCapabilities(K1_PRO);
  check('registry: keymap-editor available', isFeatureAvailable(caps, 'keymap-editor'));
  check('registry: macro-studio available', isFeatureAvailable(caps, 'macro-studio'));
  check('registry: adv-keys available (unverified)', isFeatureAvailable(caps, 'adv-keys'));
  check('registry: actuation NOT available', !isFeatureAvailable(caps, 'actuation'));
  check('registry: calibration NOT available', !isFeatureAvailable(caps, 'calibration'));
  check('registry: bogus id rejected', !isFeatureAvailable(caps, 'not-a-feature'));
  check('isFeatureId', isFeatureId('keymap-editor') && !isFeatureId('bogus'));

  const d1 = describeFeature(caps, 'actuation');
  check('describe actuation', d1.includes('not available') && d1.includes('mechanical'), d1);
  const d2 = describeFeature(caps, 'adv-keys');
  check('describe adv-keys caveat', d2.includes('not fully verified') && d2.includes('cmd-18'), d2);
  const d3 = describeFeature(caps, 'keymap-editor');
  check('describe keymap live', d3.includes('supported') && d3.includes('real hardware'), d3);
  const d4 = describeFeature(caps, 'bogus-id');
  check('describe unknown id', d4.includes('unknown feature'), d4);

  // Registry covers every capability key at least once.
  const covered = new Set<string>(
    Object.values(FEATURE_REGISTRY).map((f) => (f as { capability: string }).capability),
  );
  check(
    'registry covers all capability keys',
    CAPABILITY_KEYS.every((k) => covered.has(k)),
    [...covered].join(','),
  );

  const heCaps = getCapabilities({ vendorId: 0x1ca6, productId: 11272, usagePage: 0xffb0 });
  check('he-v2 actuation available', isFeatureAvailable(heCaps, 'actuation'));
  check('he-v2 layer-manager unavailable', !isFeatureAvailable(heCaps, 'layer-manager'));
  check('he-v2 rapid-trigger available', isFeatureAvailable(heCaps, 'rapid-trigger'));
}

// ── compatibility ──────────────────────────────────────────────────────

{
  // Matching protocol + supported features → ok.
  const ok = canApplyProfile(K1_PRO, {
    protocol: 'khub916',
    model: 'Mercury K1 PRO',
    features: ['keymap-editor', 'macro-studio', 'adv-keys'],
  });
  check('compatible profile ok', ok.ok, ok.reasons.join(' | '));

  // Mechanical feature required → rejected.
  const bad = canApplyProfile(K1_PRO, {
    protocol: 'khub916',
    features: ['keymap-editor', 'actuation'],
  });
  check('actuation profile rejected', !bad.ok);
  check('rejection names the feature', bad.reasons.some((r) => r.includes('Actuation point')), bad.reasons.join(' | '));

  // Wrong protocol → rejected.
  const wrongProto = canApplyProfile(K1_PRO, { protocol: 'he-v2', features: ['keymap-editor'] });
  check('wrong protocol rejected', !wrongProto.ok);
  check('protocol reason', wrongProto.reasons.some((r) => r.includes('he-v2')), wrongProto.reasons.join(' | '));

  // Wrong model → rejected.
  const wrongModel = canApplyProfile(K1_PRO, { model: 'K98', features: ['keymap-editor'] });
  check('wrong model rejected', !wrongModel.ok);

  // Right catalog model id → ok.
  const catOk = canApplyProfile(K1_PRO, { catalogModel: '916_K1_PRO' });
  check('catalogModel match ok', catOk.ok, catOk.reasons.join(' | '));

  // Unknown feature id in profile → rejected.
  const bogus = canApplyProfile(K1_PRO, { features: ['made-up-feature' as FeatureId] });
  check('unknown feature rejected', !bogus.ok);

  // Unknown device + model request → cannot confirm.
  const unkDev = canApplyProfile({ vendorId: 0x1234, productId: 0x5678 }, { model: 'Anything' });
  check('unknown device model unconfirmed', !unkDev.ok);
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\ncore smoke: all checks passed');
