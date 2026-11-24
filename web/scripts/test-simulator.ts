/**
 * Unit tests for `src/agent/simulator.ts` — bead oh-my-gravastar-3n0
 * ("preview changes without writing"). Runs under Node's native TS
 * stripping:
 *
 *   npm test        (node scripts/test-simulator.ts)
 *
 * Everything is mocked: a recording AgentSession stands in for
 * Khub916Session. No device, no DOM, no network — the simulator is pure.
 */

declare const process: { exit(code?: number): never };

import {
  buildDeviceContext,
  planFromOps,
  simulate,
  simulatePlan,
  type AgentSession,
  type DeviceContext,
} from '../src/agent/index.ts';
import { keyValueLabelOf } from '../src/proto/khub916.ts';
import { buildMacroRegion, type MacroEntry } from '../src/proto/macro916.ts';
import type { WriteOutcomeLike } from '../src/safety/transaction.ts';

let failures = 0;
function check(name: string, cond: unknown, extra = ''): void {
  if (cond) {
    console.log(`  ok  ${name}`);
  } else {
    failures++;
    console.error(`FAIL  ${name} ${extra}`);
  }
}
function section(title: string): void {
  console.log(`\n== ${title}`);
}

const SEL = 'auto';

// ── Shared fixtures (same shapes as test-agent.ts) ─────────────────────

function profileRaw(): Uint8Array {
  const raw = new Uint8Array(128);
  raw[9] = 0;
  raw[10] = 2;
  raw[20] = 0xff;
  raw[21] = 0xff;
  raw[24] = 10;
  raw[25] = 0x53;
  raw[24 + 1] = 0;
  return raw;
}

const K1_PRO_DEVICE = {
  vendorId: 0x258a,
  productId: 0x010c,
  productName: 'Gaming Keyboard',
};

const DEVICE_INFO = {
  uuid: '0x030000000197',
  version: 0x0100,
  versionHex: '0x0100',
  screenSize: 0,
  screen: null,
  catalogModel: '916_K1_PRO',
  catalogName: 'GravaStar Mercury K1 PRO',
};

const MACRO_ENTRIES: MacroEntry[] = [
  {
    name: 'hi',
    steps: [
      { action: 0, delayMs: 0, usage: 4, kind: 'key' },
      { action: 1, delayMs: 50, usage: 4, kind: 'key' },
    ],
  },
];

function mockSession(): { session: AgentSession; calls: { name: string; args: unknown[] }[] } {
  const calls: { name: string; args: unknown[] }[] = [];
  const rec =
    (name: string) =>
    (...args: unknown[]) => {
      calls.push({ name, args });
      return Promise.resolve<WriteOutcomeLike>({ verified: true });
    };
  const values = new Array<number>(126).fill(0);
  values[3] = 0x29; // Caps slot
  const session: AgentSession = {
    deviceInfo: async () => DEVICE_INFO,
    power: async () => ({ percent: 80, flags: 0 }),
    profile: async () => ({ raw: profileRaw(), lightMode: 2, sleepSeconds: 30 }),
    keyValues: async () => values.slice(),
    customLightColors: async () =>
      Array.from({ length: 126 }, (_, i) => ({ r: i & 0xff, g: 0, b: 0 })),
    lightColorData: async () => {
      const b = new Uint8Array(483);
      b[42] = 255;
      return b;
    },
    macroRegion: async () => buildMacroRegion(MACRO_ENTRIES),
    advKeyConfig: async () => new Uint8Array(512),
    keyConfiguration: async () => new Array<number>(128).fill(0),
    writeKeymap: rec('writeKeymap') as AgentSession['writeKeymap'],
    writeKeyConfiguration: rec('writeKeyConfiguration') as AgentSession['writeKeyConfiguration'],
    writeProfile: rec('writeProfile') as AgentSession['writeProfile'],
    writeLightData: rec('writeLightData') as AgentSession['writeLightData'],
    writeCustomLightColors: rec('writeCustomLightColors') as AgentSession['writeCustomLightColors'],
    writeMacroRegion: rec('writeMacroRegion') as AgentSession['writeMacroRegion'],
    writeAdvKeyConfig: rec('writeAdvKeyConfig') as AgentSession['writeAdvKeyConfig'],
  };
  return { session, calls };
}

async function khubContext(): Promise<DeviceContext> {
  const { session } = mockSession();
  return buildDeviceContext(session, {
    device: { ...K1_PRO_DEVICE, usagePage: 0xff00 },
  });
}

// ══════════════════════════════════════════════════════════════════════
// simulate() — raw ops path
// ══════════════════════════════════════════════════════════════════════

section('simulate — raw ops, no context');

{
  const { session, calls } = mockSession();
  void session;
  const res = simulate([
    {
      op: 'set_keymap',
      device_selector: SEL,
      layer: 0,
      entries: [{ index: 3, value: '0x0000001e' }],
    },
    { op: 'set_light', device_selector: SEL, config: { mode: 2, speed: 5, brightness: 10 } },
    {
      op: 'set_profile_section',
      device_selector: SEL,
      section: 'sleep_seconds',
      value: 60,
    },
  ]);
  check('plan valid', res.plan.valid, res.plan.errors.join(';'));
  check('validation ok (no context)', res.validation.ok, res.validation.errors.join(';'));
  check('dryRun flag', res.simulation.dryRun === true);
  check(
    'sections in execution order',
    res.simulation.sections.map((s) => s.section).join(',') === 'keymap,lighting,profile',
    res.simulation.sections.map((s) => s.section).join(','),
  );
  check('keymap write estimate = 1', res.simulation.sections[0]?.writeOps === 1);
  check('light profile-fields estimate = 1', res.simulation.sections[1]?.writeOps === 1);
  check('total estimated writes = 3', res.simulation.estimatedWriteOps === 3);
  check('affectedKeys = 1', res.simulation.affectedKeys === 1);
  check('keyChanges has slot 3', res.simulation.keyChanges[0]?.index === 3);
  check('no-context before is absent', res.simulation.keyChanges[0]?.before === undefined);
  check('after label decoded', res.simulation.keyChanges[0]?.after === keyValueLabelOf(30));
  check('profile before→after line', res.simulation.profile[0]?.includes('? → 60'));
  check('summary flattened', res.simulation.summary.length > 0);
  check('zero device writes made', calls.filter((c) => c.name.startsWith('write')).length === 0);
}

section('simulate — with DeviceContext (before→after)');

{
  const ctx = await khubContext();
  const res = simulate(
    [
      {
        op: 'set_keymap',
        device_selector: SEL,
        layer: 0,
        entries: [{ index: 3, value: '0x0000001e' }],
      },
      {
        op: 'set_light',
        device_selector: SEL,
        config: { brightness: 20, keys: { entries: [{ index: 0, color: '#ff0000' }] } },
      },
      {
        op: 'set_macro',
        device_selector: SEL,
        name: 'hi',
        steps: [{ action: 'down', key: 'KeyA' }],
        bind_key: 5,
      },
      {
        op: 'set_adv',
        device_selector: SEL,
        mode: 'mt',
        key: 7,
        tap: 4,
        hold: 30,
        hold_ms: 200,
      },
      { op: 'set_profile_section', device_selector: SEL, section: 'sleep_seconds', value: 45 },
    ],
    ctx,
  );
  check('plan valid', res.plan.valid, res.plan.errors.join(';'));
  check('validation ok', res.validation.ok, res.validation.errors.join(';'));

  // Keymap before→after: slot 3 currently holds 0x29.
  const kc = res.simulation.keyChanges.find((k) => k.index === 3);
  check('slot 3 before label present', kc?.before !== undefined, JSON.stringify(kc));
  check('slot 3 before is current value', kc?.before === keyValueLabelOf(0x29), kc?.before);
  check('slot 3 after label', kc?.after === keyValueLabelOf(30));

  // Lighting: brightness + one colour-slot entry → 2 estimated writes.
  const lightSec = res.simulation.sections.find((s) => s.section === 'lighting');
  check('lighting section writeOps = 2', lightSec?.writeOps === 2, String(lightSec?.writeOps));
  check('lighting line mentions brightness', res.simulation.lighting.some((l) => l.includes('brightness')));
  check('lighting line mentions colour slot', res.simulation.lighting.some((l) => l.includes('colour slot')));

  // Macro: replace existing 'hi' + bind → 2 writes, bind slot counted.
  const macroSec = res.simulation.sections.find((s) => s.section === 'macro');
  check('macro section writeOps = 2', macroSec?.writeOps === 2, String(macroSec?.writeOps));
  check('macro line says replace', res.simulation.macro[0]?.includes('replace'), res.simulation.macro[0]);
  check('macro line mentions bind', res.simulation.macro[0]?.includes('bind'));

  // Adv: 2 writes (keymap channel + history blob).
  const advSec = res.simulation.sections.find((s) => s.section === 'advkeys');
  check('adv section writeOps = 2', advSec?.writeOps === 2, String(advSec?.writeOps));

  // Profile: before=30 (mock sleepSeconds) → 45.
  check('profile before→after 30 → 45', res.simulation.profile[0]?.includes('30 → 45'), res.simulation.profile[0]);

  // Affected keys: slot 3 (keymap) + slot 5 (macro bind) + slot 7 (adv mt) = 3.
  // adv 'toggle' is never counted; set_keymap only wrote slot 3.
  check('affectedKeys = 3', res.simulation.affectedKeys === 3, String(res.simulation.affectedKeys));
  check(
    'keyChanges indices {3,5,7}',
    res.simulation.keyChanges.map((k) => k.index).sort((a, b) => a - b).join(',') === '3,5,7',
    res.simulation.keyChanges.map((k) => k.index).join(','),
  );

  // Write order mirrors section order: keymap, lighting, macro, advkeys, profile.
  check(
    'section order',
    res.simulation.sections.map((s) => s.section).join(',') ===
      'keymap,lighting,macro,advkeys,profile',
    res.simulation.sections.map((s) => s.section).join(','),
  );
  const total = res.simulation.estimatedWriteOps;
  check('estimatedWriteOps = 1+2+2+2+1 = 8', total === 8, String(total));
  check('writeOrder length = 8', res.simulation.writeOrder.length === 8, String(res.simulation.writeOrder.length));
  check('requiresApproval', res.simulation.requiresApproval === true);
  check('warnings surface (adv unverified)', res.simulation.warnings.some((w) => w.includes('unverified')), res.simulation.warnings.join(';'));
}

section('simulate — restore_snapshot estimate');

{
  const res = simulate([
    {
      op: 'restore_snapshot',
      device_selector: SEL,
      id: 'snap-1',
      sections: ['keymap', 'macro'],
    },
    {
      op: 'set_keymap',
      device_selector: SEL,
      layer: 0,
      entries: [{ index: 0, value: 1 }],
    },
  ]);
  const snapSec = res.simulation.sections.find((s) => s.section === 'snapshot');
  check('snapshot writeOps = 2 sections', snapSec?.writeOps === 2, String(snapSec?.writeOps));
  check('snapshot sorts last', res.simulation.sections[res.simulation.sections.length - 1]?.section === 'snapshot');
  check('writeOrder has per-section labels', res.simulation.writeOrder.some((w) => w.includes('(keymap)')));
  check('restore line lists sections', res.simulation.summary.some((l) => l.includes('snap-1')));
}

// ══════════════════════════════════════════════════════════════════════
// simulatePlan() — pre-built plan path + validation passthrough
// ══════════════════════════════════════════════════════════════════════

section('simulatePlan — validation findings flow through');

{
  const ctx = await khubContext();
  // Two set_keymap ops on the same layer/system → validator error.
  const plan = planFromOps(
    [
      { op: 'set_keymap', device_selector: SEL, layer: 0, entries: [{ index: 0, value: 1 }] },
      { op: 'set_keymap', device_selector: SEL, layer: 0, entries: [{ index: 1, value: 2 }] },
    ],
    ctx,
  );
  const res = simulatePlan(plan, ctx);
  check('duplicate keymap target → validation error', !res.validation.ok);
  check('error in simulation.errors', res.simulation.errors.some((e) => e.includes('layer/system 0:0')));
  check('simulation still produced (preview is honest about failure)', res.simulation.sections.length === 1);
}

{
  // Schema-broken ops → invalid plan → errors surface, no crash.
  const res = simulate([{ op: 'bogus_op', device_selector: SEL }]);
  check('bogus op → invalid plan', !res.plan.valid);
  check('bogus op → validation not ok', !res.validation.ok);
  check('bogus op → simulation.errors non-empty', res.simulation.errors.length > 0);
  check('bogus op → zero writes estimated', res.simulation.estimatedWriteOps === 0);
  check('bogus op → dryRun still true', res.simulation.dryRun === true);
}

{
  // Compx mouse context → capability gate rejects keymap writes.
  const ctx = await buildDeviceContext({}, {
    device: { vendorId: 0x3554, productId: 0xf54b, usagePage: 0xff02 },
  });
  const res = simulate(
    [{ op: 'set_keymap', device_selector: SEL, layer: 0, entries: [{ index: 0, value: 1 }] }],
    ctx,
  );
  check('compx device → validation error', !res.validation.ok);
  check('compx error mentions capability', res.simulation.errors.some((e) => e.includes('keymap')));
}

{
  // Empty light config can't reach here (schema rejects), but a config
  // with only unmapped fields would warn — verify mapped-field split.
  const res = simulate([
    {
      op: 'set_light',
      device_selector: SEL,
      config: {
        color: '#00ff00',
        keys: { colors: Array.from({ length: 126 }, (_, i) => ({ r: i, g: 0, b: 0 })) },
      },
    },
  ]);
  const lightSec = res.simulation.sections.find((s) => s.section === 'lighting');
  check('group colour + full table = 2 writes', lightSec?.writeOps === 2, String(lightSec?.writeOps));
  check('writeOrder mirrors light split', res.simulation.writeOrder.length === 2);
}

// ══════════════════════════════════════════════════════════════════════

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall simulator checks passed');
