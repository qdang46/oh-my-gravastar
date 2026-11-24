/**
 * Unit tests for `src/agent/` — the agent-first layer
 * (docs/AGENT-ARCHITECTURE.md, bead oh-my-gravastar-ak2). Runs under
 * Node's native TS stripping:
 *
 *   npm test        (node scripts/test-agent.ts)
 *
 * Everything is mocked: a recording AgentSession stands in for
 * Khub916Session, memoryStorage stands in for localStorage. No device,
 * no DOM, no network.
 */

declare const process: { exit(code?: number): never };

import {
  AGENT_SCHEMA_VERSION,
  buildDeviceContext,
  buildDryRunReport,
  executePlan,
  planFromOps,
  validateOp,
  validatePlan,
  validatePlanAgainstContext,
  WRITE_FRICTION_OPS,
  type AgentSession,
  type DeviceContext,
} from '../src/agent/index.ts';
import { memoryStorage, SnapshotStore, type SnapshotSource } from '../src/safety/index.ts';
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

// ── Shared fixtures ────────────────────────────────────────────────────

/** Profile blob that decodeLightState/withLightMode can work with. */
function profileRaw(): Uint8Array {
  const raw = new Uint8Array(128);
  raw[9] = 0;
  raw[10] = 2; // light mode 2 (breathing)
  raw[20] = 0xff;
  raw[21] = 0xff; // FF FF marker → base 22
  raw[24] = 10; // brightness record for mode 2
  raw[25] = 0x53; // speed 5 << 4 | type 3
  raw[24 + 1] = 0; // keep packed sane
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
      { action: 0, delayMs: 0, usage: 4, kind: 'key' }, // KeyA down
      { action: 1, delayMs: 50, usage: 4, kind: 'key' }, // KeyA up
    ],
  },
];

/** Read+write mock session; records every write call. */
function mockSession(opts: { failWrites?: string[] } = {}): {
  session: AgentSession;
  calls: { name: string; args: unknown[] }[];
} {
  const calls: { name: string; args: unknown[] }[] = [];
  const rec =
    (name: string) =>
    (...args: unknown[]) => {
      calls.push({ name, args });
      if (opts.failWrites?.includes(name)) {
        return Promise.reject(new Error(`${name} exploded`));
      }
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
      b[42] = 255; // mode-2 group colour offset (2*21)
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

const approveAll = () => true;

async function khubContext(snapshots?: SnapshotStore): Promise<DeviceContext> {
  const { session } = mockSession();
  return buildDeviceContext(session, {
    device: { ...K1_PRO_DEVICE, usagePage: 0xff00 },
    ...(snapshots ? { snapshots } : {}),
  });
}

section('device-context — selector passthrough');

{
  const ctx = await khubContext();
  check(
    'context carries 0xVID:0xPID selector for plan device fields',
    ctx.device.selector === '0x258a:0x010c',
    ctx.device.selector,
  );
}

// ══════════════════════════════════════════════════════════════════════
// action-schema.ts
// ══════════════════════════════════════════════════════════════════════

section('schema — validateOp accept/reject');

{
  const v = validateOp({
    op: 'set_keymap',
    device_selector: SEL,
    layer: 0,
    entries: [{ index: 3, value: '0x0000001e' }],
  });
  check('set_keymap hex value accepted + normalised', v.ok && v.op?.op === 'set_keymap');
  if (v.op?.op === 'set_keymap') {
    check('value parsed to u32', v.op.entries[0]?.value === 30);
  }
}
{
  const v = validateOp({ op: 'bogus_op', device_selector: SEL });
  check('unknown op rejected', !v.ok && v.errors.some((e) => e.includes('unknown op')));
}
{
  const v = validateOp({ op: 'set_keymap', layer: 0, entries: [{ index: 0, value: 1 }] });
  check('missing device_selector rejected', !v.ok);
}
{
  const v = validateOp({
    op: 'set_keymap',
    device_selector: SEL,
    layer: 4,
    entries: [{ index: 0, value: 1 }],
  });
  check('layer 4 rejected', !v.ok);
}
{
  const v = validateOp({
    op: 'set_keymap',
    device_selector: SEL,
    layer: 0,
    entries: [
      { index: 5, value: 1 },
      { index: 5, value: 2 },
    ],
  });
  check('duplicate keymap index rejected', !v.ok && v.errors.some((e) => e.includes('duplicate')));
}
{
  const v = validateOp({
    op: 'set_keymap',
    device_selector: SEL,
    layer: 0,
    entries: [{ index: 0, value: 'not-a-key' }],
  });
  check('bad keymap value rejected', !v.ok);
}
{
  const v = validateOp({
    op: 'set_light',
    device_selector: SEL,
    config: { mode: 2, speed: 5, brightness: 10 },
  });
  check('set_light valid config accepted', v.ok, v.errors.join(';'));
}
{
  const v = validateOp({ op: 'set_light', device_selector: SEL, config: {} });
  check('empty light config rejected', !v.ok);
}
{
  const v = validateOp({
    op: 'set_light',
    device_selector: SEL,
    config: { keys: { preset: 'rainbow' } },
  });
  check('keys.preset rejected (no wire mapping)', !v.ok && v.errors.some((e) => e.includes('preset')));
}
{
  const v = validateOp({
    op: 'set_macro',
    device_selector: SEL,
    name: 'jump',
    steps: [
      { key: 'h', up: false, delay_ms: 0 },
      { key: 'h', up: true, delay_ms: 50 },
    ],
  });
  check('set_macro with up-sugar accepted', v.ok, v.errors.join(';'));
  if (v.op?.op === 'set_macro' && Array.isArray(v.op.steps)) {
    const s0 = v.op.steps[0] as Record<string, unknown>;
    check('up:false folded to action down + KeyH', s0.action === 'down' && s0.key === 'KeyH');
  }
}
{
  const v = validateOp({
    op: 'set_macro',
    device_selector: SEL,
    name: 'bad',
    steps: [{ action: 'down', key: 'NotAKey' }],
  });
  check('bad macro step rejected', !v.ok);
}
{
  const v = validateOp({ op: 'set_macro', device_selector: SEL, delete: true });
  check('macro delete without target rejected', !v.ok);
}
{
  const v = validateOp({
    op: 'set_adv',
    device_selector: SEL,
    mode: 'mt',
    key: 3,
    tap: '0x00000004',
    hold: 30,
    hold_ms: 200,
  });
  check('set_adv mt accepted', v.ok, v.errors.join(';'));
  if (v.op?.op === 'set_adv') check('tap hex normalised', v.op.tap === 4);
}
{
  const v = validateOp({ op: 'set_adv', device_selector: SEL, mode: 'mt', key: 3, tap: 1 });
  check('set_adv mt missing hold rejected', !v.ok);
}
{
  const v = validateOp({
    op: 'restore_snapshot',
    device_selector: SEL,
    id: 'snap-x',
    sections: ['keymap', 'bogus'],
  });
  check('bad snapshot section rejected', !v.ok);
}
{
  const v = validateOp({
    op: 'set_profile_section',
    device_selector: SEL,
    section: 'sleep_seconds',
    value: 30,
  });
  check('set_profile_section sleep_seconds accepted', v.ok);
}
{
  const v = validateOp({
    op: 'set_profile_section',
    device_selector: SEL,
    section: 'light_mode',
    value: 2,
  });
  check('unsupported profile section rejected', !v.ok);
}

section('schema — validatePlan envelope');

{
  const v = validatePlan({
    schema_version: AGENT_SCHEMA_VERSION,
    device_selector: SEL,
    ops: [
      { op: 'set_keymap', device_selector: SEL, layer: 0, entries: [{ index: 0, value: 1 }] },
    ],
  });
  check('valid plan request accepted', v.ok && v.ops?.length === 1, v.errors.join(';'));
}
{
  const v = validatePlan({ schema_version: 2, ops: [] });
  check('schema_version 2 rejected', !v.ok && v.errors.some((e) => e.includes('schema_version')));
}
{
  const v = validatePlan([{ op: 'set_keymap', device_selector: SEL, layer: 0, entries: [{ index: 0, value: 1 }] }]);
  check('bare ops array accepted', v.ok);
}
{
  const v = validatePlan({ ops: [] });
  check('empty ops rejected', !v.ok);
}

// ══════════════════════════════════════════════════════════════════════
// planner.ts
// ══════════════════════════════════════════════════════════════════════

section('planner — ordering / policy / diffs');

{
  const plan = planFromOps(
    [
      { op: 'restore_snapshot', device_selector: SEL, id: 'snap-1', sections: ['keymap'] },
      { op: 'set_profile_section', device_selector: SEL, section: 'sleep_seconds', value: 30 },
      {
        op: 'set_adv',
        device_selector: SEL,
        mode: 'mt',
        key: 3,
        tap: 4,
        hold: 30,
        hold_ms: 200,
      },
      {
        op: 'set_macro',
        device_selector: SEL,
        name: 'hi',
        steps: [{ action: 'down', key: 'KeyA', delay_ms: 0 }],
      },
      { op: 'set_light', device_selector: SEL, config: { mode: 2, speed: 5 } },
      {
        op: 'set_keymap',
        device_selector: SEL,
        layer: 1,
        entries: [{ index: 0, value: 30 }],
      },
    ],
    await khubContext(),
  );
  check('plan valid', plan.valid, plan.errors.join(';'));
  check(
    'ops ordered keymap→lighting→macro→advkeys→profile→snapshot',
    plan.ops.map((o) => o.section).join(',') ===
      'keymap,lighting,macro,advkeys,profile,snapshot',
    plan.ops.map((o) => o.section).join(','),
  );
  check('restore_snapshot last', plan.ops[plan.ops.length - 1]?.op.op === 'restore_snapshot');
  check('requiresApproval set', plan.requiresApproval === true);
  check('diffSummary mirrors diffs', plan.diffSummary.length === plan.ops.length);
  check('keymap op is L2', plan.ops[0]?.policy.class === 'L2');
}

{
  const plan = planFromOps(
    [{ op: 'set_keymap', device_selector: 'path-a', layer: 0, entries: [{ index: 0, value: 1 }] }],
  );
  check('single selector echoed', plan.device_selector === 'path-a');
  check(
    'single selector in device_selectors',
    plan.device_selectors.length === 1 && plan.device_selectors[0] === 'path-a',
    JSON.stringify(plan.device_selectors),
  );

  const mixed = planFromOps([
    { op: 'set_keymap', device_selector: 'auto', layer: 0, entries: [{ index: 0, value: 1 }] },
    { op: 'set_keymap', device_selector: 'vid:9999', layer: 1, entries: [{ index: 0, value: 1 }] },
    { op: 'set_keymap', device_selector: 'auto', layer: 2, entries: [{ index: 0, value: 1 }] },
  ]);
  check('mixed selectors flagged', mixed.device_selector === 'mixed' && mixed.warnings.length > 0);
  check(
    'device_selectors dedupes, first-seen order (plan-json device passthrough)',
    mixed.device_selectors.join(',') === 'auto,vid:9999',
    JSON.stringify(mixed.device_selectors),
  );
}

{
  // Layout key-name resolution: "Caps" is K1 Pro block pos 20 → index 3.
  const ctx = await khubContext();
  const plan = planFromOps(
    [
      {
        op: 'set_adv',
        device_selector: SEL,
        mode: 'mt',
        key: 'Caps',
        tap: 4,
        hold: 30,
        hold_ms: 200,
      },
    ],
    ctx,
  );
  check('layout name resolved to slot', plan.valid, plan.errors.join(';'));
  const op = plan.ops[0]?.op;
  check(
    'Caps → keymap index 3',
    op !== undefined && op.op === 'set_adv' && op.key === 3,
    JSON.stringify(op !== undefined && op.op === 'set_adv' ? op.key : op),
  );
}

{
  const plan = planFromOps(
    [{ op: 'set_adv', device_selector: SEL, mode: 'mt', key: 'NoSuchKey', tap: 1, hold: 2 }],
    await khubContext(),
  );
  check('unresolvable key name → plan error', !plan.valid && plan.errors.length > 0);
}

{
  const plan = planFromOps([{ op: 'bogus', device_selector: SEL }]);
  check('schema-broken op → invalid plan', !plan.valid && plan.ops.length === 0);
}

// ══════════════════════════════════════════════════════════════════════
// validator.ts
// ══════════════════════════════════════════════════════════════════════

section('validator — capability / policy / conflicts / storage');

{
  const ctx = await khubContext();
  const plan = planFromOps(
    [
      {
        op: 'set_keymap',
        device_selector: SEL,
        layer: 0,
        entries: [{ index: 3, value: '0x0000001e' }],
      },
    ],
    ctx,
  );
  const v = validatePlanAgainstContext(plan, ctx);
  check('khub916 keymap plan validates', v.ok, v.errors.join(';'));
}

{
  // Compx mouse: every capability unsupported-hardware → hard reject.
  // (Empty reader — a deviceInfo uuid would classify as khub916 instead.)
  const ctx = await buildDeviceContext({}, {
    device: { vendorId: 0x3554, productId: 0xf54b, usagePage: 0xff02 },
  });
  const plan = planFromOps(
    [
      {
        op: 'set_keymap',
        device_selector: SEL,
        layer: 0,
        entries: [{ index: 0, value: 1 }],
      },
    ],
    ctx,
  );
  const v = validatePlanAgainstContext(plan, ctx);
  check('compx device rejects keymap write', !v.ok && v.errors.some((e) => e.includes('keymap')), v.errors.join(';'));
}

{
  // adv_keys is 'unverified' on khub916 → warning, not error (R5).
  const ctx = await khubContext();
  const plan = planFromOps(
    [
      {
        op: 'set_adv',
        device_selector: SEL,
        mode: 'mt',
        key: 3,
        tap: 4,
        hold: 30,
        hold_ms: 200,
      },
    ],
    ctx,
  );
  const v = validatePlanAgainstContext(plan, ctx);
  check('adv_keys unverified → warning not error', v.ok && v.warnings.some((w) => w.includes('unverified')), v.warnings.join(';'));
}

{
  const ctx = await khubContext();
  const dup = planFromOps(
    [
      { op: 'set_keymap', device_selector: SEL, layer: 0, entries: [{ index: 0, value: 1 }] },
      { op: 'set_keymap', device_selector: SEL, layer: 0, entries: [{ index: 1, value: 2 }] },
    ],
    ctx,
  );
  const v = validatePlanAgainstContext(dup, ctx);
  check('duplicate keymap target rejected', !v.ok && v.errors.some((e) => e.includes('layer/system 0:0')), v.errors.join(';'));
}

{
  const ctx = await khubContext();
  const macros = planFromOps(
    [
      {
        op: 'set_macro',
        device_selector: SEL,
        name: 'same',
        steps: [{ action: 'down', key: 'KeyA' }],
      },
      {
        op: 'set_macro',
        device_selector: SEL,
        name: 'SAME',
        steps: [{ action: 'down', key: 'KeyB' }],
      },
    ],
    ctx,
  );
  const v = validatePlanAgainstContext(macros, ctx);
  check('macro name collision (case-insensitive) rejected', !v.ok && v.errors.some((e) => e.includes('set_macro name')), v.errors.join(';'));
}

{
  const ctx = await khubContext();
  // set_keymap writes arg0 slot 3; set_adv mt binds key 3 → warning.
  const clash = planFromOps(
    [
      { op: 'set_keymap', device_selector: SEL, layer: 0, entries: [{ index: 3, value: 30 }] },
      {
        op: 'set_adv',
        device_selector: SEL,
        mode: 'mt',
        key: 3,
        tap: 4,
        hold: 30,
      },
    ],
    ctx,
  );
  const v = validatePlanAgainstContext(clash, ctx);
  check('keymap/adv slot clash → warning', v.ok && v.warnings.some((w) => w.includes('written by both')), v.warnings.join(';'));
}

{
  const ctx = await khubContext();
  ctx.state.macroFreeBytes = 4; // force storage-limit failure
  const plan = planFromOps(
    [
      {
        op: 'set_macro',
        device_selector: SEL,
        name: 'toolong',
        steps: Array.from({ length: 20 }, () => ({ action: 'down', key: 'KeyA' })),
      },
    ],
    ctx,
  );
  const v = validatePlanAgainstContext(plan, ctx);
  check('macro storage limit enforced', !v.ok && v.errors.some((e) => e.includes('free')), v.errors.join(';'));
}

{
  // Snapshot existence: capture one, then ask for a bogus id.
  const store = new SnapshotStore(memoryStorage());
  const src: SnapshotSource = {
    keyValues: async () => [1, 2],
    lightColorData: async () => new Uint8Array(4),
    customLightColors: async () => [],
    profile: async () => ({ raw: new Uint8Array(128) }),
    macroRegion: async () => new Uint8Array(512),
  };
  const snap = await store.capture(src, 'pre');
  const ctx = await khubContext(store);

  const good = planFromOps(
    [{ op: 'restore_snapshot', device_selector: SEL, id: snap.id, sections: ['macro'] }],
    ctx,
  );
  const vg = validatePlanAgainstContext(good, ctx);
  check('known snapshot id validates', vg.ok, vg.errors.join(';'));

  const bad = planFromOps(
    [{ op: 'restore_snapshot', device_selector: SEL, id: 'snap-nope' }],
    ctx,
  );
  const vb = validatePlanAgainstContext(bad, ctx);
  check('unknown snapshot id rejected', !vb.ok && vb.errors.some((e) => e.includes('snap-nope')));
}

{
  // Forged L4 policy LABEL is ignored — the validator re-derives the
  // class from the op kind (set_keymap is genuinely L2).
  const ctx = await khubContext();
  const plan = planFromOps(
    [
      {
        op: 'set_keymap',
        device_selector: SEL,
        layer: 0,
        entries: [{ index: 0, value: 1 }],
      },
    ],
    ctx,
  );
  plan.ops[0]!.policy = {
    class: 'L4',
    requiresApproval: false,
    allowed: false,
    reason: 'blacklisted',
  };
  const v = validatePlanAgainstContext(plan, ctx);
  check('forged L4 label ignored — class re-derived', v.ok, v.errors.join(';'));
}

{
  // A forged unknown op kind can never reach execution.
  const ctx = await khubContext();
  const plan = planFromOps(
    [
      {
        op: 'set_keymap',
        device_selector: SEL,
        layer: 0,
        entries: [{ index: 0, value: 1 }],
      },
    ],
    ctx,
  );
  plan.ops.push({
    op: { op: 'factory_reset', device_selector: SEL } as never,
    section: 'forbidden',
    policy: { class: 'L4', requiresApproval: false, allowed: false, reason: 'x' },
    diff: 'forged',
  });
  const v = validatePlanAgainstContext(plan, ctx);
  check('unknown op kind refused', !v.ok && v.errors.some((e) => e.includes('unknown op kind')));
}

{
  // Schema-broken plan short-circuits.
  const ctx = await khubContext();
  const plan = planFromOps([{ op: 'bogus', device_selector: SEL }], ctx);
  const v = validatePlanAgainstContext(plan, ctx);
  check('invalid plan fails validation', !v.ok);
}

// ── fw6: deeper validation ─────────────────────────────────────────────

section('validator — lighting interactions');

{
  const ctx = await khubContext();
  // Per-key colour table under the current mode (breathing, SINGLE) —
  // writes succeed but only 'custom' (277) displays them.
  const plan = planFromOps(
    [
      {
        op: 'set_light',
        device_selector: SEL,
        config: { keys: { colors: Array.from({ length: 126 }, () => '#ff0000') } },
      },
    ],
    ctx,
  );
  const v = validatePlanAgainstContext(plan, ctx);
  check('per-key colours under non-custom mode → warning', v.ok && v.warnings.some((w) => w.includes('custom') && w.includes('277')), v.warnings.join(';'));
}
{
  const ctx = await khubContext();
  // Same table WITH mode 277 in the same config → clean.
  const plan = planFromOps(
    [
      {
        op: 'set_light',
        device_selector: SEL,
        config: { mode: 277, keys: { colors: Array.from({ length: 126 }, () => '#ff0000') } },
      },
    ],
    ctx,
  );
  const v = validatePlanAgainstContext(plan, ctx);
  check('per-key colours + mode 277 → no mode warning', v.ok && !v.warnings.some((w) => w.includes('only displays')), v.warnings.join(';'));
}
{
  const ctx = await khubContext();
  // Group colour while switching to 'custom' (277) — no colour slot at
  // mode*21 → the executor write would fail; validator must error.
  const plan = planFromOps(
    [
      {
        op: 'set_light',
        device_selector: SEL,
        config: { mode: 277, color: '#00ff00' },
      },
    ],
    ctx,
  );
  const v = validatePlanAgainstContext(plan, ctx);
  check('group colour + mode 277 → error', !v.ok && v.errors.some((e) => e.includes('colour slot')), v.errors.join(';'));
}
{
  const ctx = await khubContext();
  // Group colour under mode 0 (off) → warning, not error.
  const plan = planFromOps(
    [
      {
        op: 'set_light',
        device_selector: SEL,
        config: { mode: 0, color: '#00ff00' },
      },
    ],
    ctx,
  );
  const v = validatePlanAgainstContext(plan, ctx);
  check('group colour + mode off → warning', v.ok && v.warnings.some((w) => w.includes("mode is 'off'")), v.warnings.join(';'));
}
{
  const ctx = await khubContext();
  // Two set_light ops both picking a mode → error (last wins silently).
  const plan = planFromOps(
    [
      { op: 'set_light', device_selector: SEL, config: { mode: 2 } },
      { op: 'set_light', device_selector: SEL, config: { mode: 5, speed: 3 } },
    ],
    ctx,
  );
  const v = validatePlanAgainstContext(plan, ctx);
  check('duplicate light mode → error', !v.ok && v.errors.some((e) => e.includes("set 'mode'")), v.errors.join(';'));
}
{
  const ctx = await khubContext();
  // One set_light with mode, one without → no duplicate-mode error.
  const plan = planFromOps(
    [
      { op: 'set_light', device_selector: SEL, config: { mode: 2 } },
      { op: 'set_light', device_selector: SEL, config: { brightness: 8 } },
    ],
    ctx,
  );
  const v = validatePlanAgainstContext(plan, ctx);
  check('light mode + field-only op → ok', v.ok, v.errors.join(';'));
}

section('validator — duplicate targets / ordering / friction');

{
  const ctx = await khubContext();
  const plan = planFromOps(
    [
      { op: 'set_profile_section', device_selector: SEL, section: 'sleep_seconds', value: 30 },
      { op: 'set_profile_section', device_selector: SEL, section: 'sleep_seconds', value: 60 },
    ],
    ctx,
  );
  const v = validatePlanAgainstContext(plan, ctx);
  check('duplicate profile section → error', !v.ok && v.errors.some((e) => e.includes('sleep_seconds')), v.errors.join(';'));
}
{
  const ctx = await khubContext();
  // Two adv ops on the same key → slot warning + shared-blob warning.
  const plan = planFromOps(
    [
      { op: 'set_adv', device_selector: SEL, mode: 'mt', key: 3, tap: 4, hold: 30 },
      { op: 'set_adv', device_selector: SEL, mode: 'socd', key_a: 3, key_b: 4, direction: 0 },
    ],
    ctx,
  );
  const v = validatePlanAgainstContext(plan, ctx);
  check('adv ops share blob → warning', v.ok && v.warnings.some((w) => w.includes('history blob')), v.warnings.join(';'));
  check('adv same key → slot warning', v.warnings.some((w) => w.includes('adv key 3')), v.warnings.join(';'));
}
{
  const ctx = await khubContext();
  // Macro bind on layer 1 collides with a layer-1 keymap write — the
  // old arg-0-only check missed this; the arg-keyed check catches it.
  const plan = planFromOps(
    [
      { op: 'set_keymap', device_selector: SEL, layer: 1, entries: [{ index: 7, value: 30 }] },
      {
        op: 'set_macro',
        device_selector: SEL,
        name: 'bindme',
        steps: [{ action: 'down', key: 'KeyA' }],
        bind_key: 7,
        bind_layer: 1,
      },
    ],
    ctx,
  );
  const v = validatePlanAgainstContext(plan, ctx);
  check('macro bind on layer 1 vs keymap L1 → warning', v.ok && v.warnings.some((w) => w.includes('arg 1 slot 7')), v.warnings.join(';'));
}
{
  const ctx = await khubContext();
  // Forge a plan with restore_snapshot NOT last — planner would never
  // produce this, but a hand-built plan could.
  const plan = planFromOps(
    [
      { op: 'restore_snapshot', device_selector: SEL, id: 'snap-x' },
      { op: 'set_keymap', device_selector: SEL, layer: 0, entries: [{ index: 0, value: 1 }] },
    ],
    ctx,
  );
  // Reorder ops to simulate a forged/interleaved plan.
  plan.ops.reverse();
  const v = validatePlanAgainstContext(plan, ctx);
  check('restore not last → error', !v.ok && v.errors.some((e) => e.includes('not the last op')), v.errors.join(';'));
}
{
  const ctx = await khubContext();
  // Friction: more ops than WRITE_FRICTION_OPS → warning, still valid.
  const ops: unknown[] = [];
  for (let l = 0; l < 4; l++) {
    ops.push({
      op: 'set_keymap',
      device_selector: SEL,
      layer: l,
      entries: [{ index: l, value: 30 }],
    });
  }
  ops.push(
    { op: 'set_light', device_selector: SEL, config: { speed: 5 } },
    { op: 'set_light', device_selector: SEL, config: { brightness: 9 } },
    {
      op: 'set_macro',
      device_selector: SEL,
      name: 'f1',
      steps: [{ action: 'down', key: 'KeyA' }],
    },
    {
      op: 'set_macro',
      device_selector: SEL,
      name: 'f2',
      steps: [{ action: 'down', key: 'KeyB' }],
    },
    { op: 'set_profile_section', device_selector: SEL, section: 'sleep_seconds', value: 20 },
  );
  const plan = planFromOps(ops, ctx);
  check(`friction fixture has >${WRITE_FRICTION_OPS} ops`, plan.ops.length > WRITE_FRICTION_OPS, String(plan.ops.length));
  const v = validatePlanAgainstContext(plan, ctx);
  check('oversized plan → friction warning', v.ok && v.warnings.some((w) => w.includes('large change set')), v.warnings.join(';'));
}
{
  const ctx = await khubContext();
  // Aggregate macro budget: two new macros each fit individually but
  // overflow the region together.
  ctx.state.macroFreeBytes = 100;
  const step = { action: 'down', key: 'KeyA' };
  const plan = planFromOps(
    [
      { op: 'set_macro', device_selector: SEL, name: 'agg1', steps: Array.from({ length: 20 }, () => step) },
      { op: 'set_macro', device_selector: SEL, name: 'agg2', steps: Array.from({ length: 20 }, () => step) },
    ],
    ctx,
  );
  const v = validatePlanAgainstContext(plan, ctx);
  check('aggregate macro overflow → error', !v.ok && v.errors.some((e) => e.includes('total')), v.errors.join(';'));
}

// ══════════════════════════════════════════════════════════════════════
// executor.ts
// ══════════════════════════════════════════════════════════════════════

section('executor — dry-run / approval / transaction');

{
  const ctx = await khubContext();
  const { session, calls } = mockSession();
  const plan = planFromOps(
    [
      {
        op: 'set_keymap',
        device_selector: SEL,
        layer: 0,
        entries: [{ index: 3, value: '0x0000001e' }],
      },
    ],
    ctx,
  );
  const res = await executePlan(plan, { session, context: ctx, dryRun: true });
  check('dry-run ok', res.ok === true, res.errors.join(';'));
  check('dry-run made zero writes', calls.filter((c) => c.name.startsWith('write')).length === 0);
  check('dry-run has preview', res.preview !== undefined && res.preview.ops.length > 0);
  check('dry-run has no tx', res.tx === undefined);
}

{
  const ctx = await khubContext();
  const { session, calls } = mockSession();
  const plan = planFromOps(
    [
      {
        op: 'set_keymap',
        device_selector: SEL,
        layer: 0,
        entries: [{ index: 3, value: '0x0000001e' }],
      },
    ],
    ctx,
  );
  const res = await executePlan(plan, { session, context: ctx, approve: approveAll });
  check('approved plan executes', res.ok === true, res.errors.join(';'));
  const km = calls.find((c) => c.name === 'writeKeymap');
  check('writeKeymap called', km !== undefined);
  const values = km?.args[2] as number[];
  check('slot 3 patched to 30', values[3] === 30 && values[0] === 0);
  check('tx journal success', res.tx?.journal[0]?.result === 'success');
}

{
  const ctx = await khubContext();
  const { session, calls } = mockSession();
  const plan = planFromOps(
    [
      {
        op: 'set_keymap',
        device_selector: SEL,
        layer: 0,
        entries: [{ index: 3, value: 30 }],
      },
    ],
    ctx,
  );
  const res = await executePlan(plan, { session, context: ctx, approve: false });
  check('denied approval → not ok', res.ok === false);
  check('denied approval → zero writes', calls.filter((c) => c.name.startsWith('write')).length === 0);
}

{
  const ctx = await khubContext();
  const { session } = mockSession();
  const plan = planFromOps(
    [
      {
        op: 'set_keymap',
        device_selector: SEL,
        layer: 0,
        entries: [{ index: 0, value: 1 }],
      },
    ],
    ctx,
  );
  // Forge a capability failure by validating against a compx context.
  const compxCtx = await buildDeviceContext({}, {
    device: { vendorId: 0x3554, productId: 0xf54b, usagePage: 0xff02 },
  });
  const res = await executePlan(plan, { session, context: compxCtx, approve: approveAll });
  check('capability failure → no writes', res.ok === false && res.tx === undefined);
}

{
  // Transaction integration: macro write fails → later profile op never runs.
  const ctx = await khubContext();
  const { session, calls } = mockSession({ failWrites: ['writeMacroRegion'] });
  const plan = planFromOps(
    [
      {
        op: 'set_macro',
        device_selector: SEL,
        name: 'newmacro',
        steps: [{ action: 'down', key: 'KeyA', delay_ms: 0 }],
      },
      { op: 'set_profile_section', device_selector: SEL, section: 'sleep_seconds', value: 45 },
    ],
    ctx,
  );
  const res = await executePlan(plan, { session, context: ctx, approve: approveAll });
  check('partial failure reported', res.ok === false && res.tx?.completed === false);
  check('writeProfile never reached', !calls.some((c) => c.name === 'writeProfile'));
  check('macro region write attempted', calls.some((c) => c.name === 'writeMacroRegion'));
}

{
  // set_macro happy path: region written, entry decodable, bind writes keymap.
  const ctx = await khubContext();
  const { session, calls } = mockSession();
  const plan = planFromOps(
    [
      {
        op: 'set_macro',
        device_selector: SEL,
        name: 'fresh',
        steps: [
          { action: 'down', key: 'KeyA', delay_ms: 0 },
          { action: 'up', key: 'KeyA', delay_ms: 30 },
        ],
        bind_key: 10,
      },
    ],
    ctx,
  );
  const res = await executePlan(plan, { session, context: ctx, approve: approveAll });
  check('macro plan executes', res.ok === true, res.errors.join(';'));
  const regionCall = calls.find((c) => c.name === 'writeMacroRegion');
  check('macro region written', regionCall !== undefined);
  const kmCall = calls.find((c) => c.name === 'writeKeymap');
  check('macro bind wrote keymap', kmCall !== undefined);
  const bound = kmCall ? ((kmCall.args[2] as number[])[10] ?? 0) : 0;
  check('bind value is tag-3 macro key', ((bound ?? 0) >>> 24) === 0x03, `got 0x${(bound ?? 0).toString(16)}`);
}

{
  // set_profile_section: sleep_seconds write through profile blob.
  const ctx = await khubContext();
  const { session, calls } = mockSession();
  const plan = planFromOps(
    [{ op: 'set_profile_section', device_selector: SEL, section: 'sleep_seconds', value: 45 }],
    ctx,
  );
  const res = await executePlan(plan, { session, context: ctx, approve: approveAll });
  check('profile section executes', res.ok === true, res.errors.join(';'));
  const prof = calls.find((c) => c.name === 'writeProfile');
  check('profile blob written', prof !== undefined);
  check('sleep byte patched', (prof?.args[0] as Uint8Array)[24] === 45);
}

{
  // restore_snapshot end-to-end through planRestore.
  const store = new SnapshotStore(memoryStorage());
  const src: SnapshotSource = {
    keyValues: async (arg) => [0x1000 + arg, 0x5aa5],
    lightColorData: async () => new Uint8Array([1, 2, 3, 4]),
    customLightColors: async () => Array.from({ length: 126 }, () => ({ r: 1, g: 2, b: 3 })),
    profile: async () => ({ raw: new Uint8Array(128).fill(7) }),
    macroRegion: async () => new Uint8Array(512).fill(9),
  };
  const snap = await store.capture(src, 'before');
  const ctx = await khubContext(store);
  const { session, calls } = mockSession();
  const plan = planFromOps(
    [{ op: 'restore_snapshot', device_selector: SEL, id: snap.id, sections: ['keymap', 'macro'] }],
    ctx,
  );
  const res = await executePlan(plan, { session, context: ctx, snapshots: store, approve: approveAll });
  check('restore executes', res.ok === true, res.errors.join(';'));
  check('restore wrote keymap + macro only',
    calls.filter((c) => c.name === 'writeKeymap').length === 8 &&
      calls.filter((c) => c.name === 'writeMacroRegion').length === 1 &&
      !calls.some((c) => c.name === 'writeProfile'),
    calls.map((c) => c.name).join(','));
}

{
  // Dry-run of a restore still expands sections but writes nothing.
  const store = new SnapshotStore(memoryStorage());
  const src: SnapshotSource = {
    keyValues: async () => [1],
    lightColorData: async () => new Uint8Array(4),
    customLightColors: async () => [],
    profile: async () => ({ raw: new Uint8Array(128) }),
    macroRegion: async () => new Uint8Array(512),
  };
  const snap = await store.capture(src, 'before');
  const ctx = await khubContext(store);
  const { session, calls } = mockSession();
  const plan = planFromOps(
    [{ op: 'restore_snapshot', device_selector: SEL, id: snap.id }],
    ctx,
  );
  const res = await executePlan(plan, {
    session,
    context: ctx,
    snapshots: store,
    dryRun: true,
  });
  check('restore dry-run ok', res.ok === true, res.errors.join(';'));
  check('restore dry-run wrote nothing', calls.filter((c) => c.name.startsWith('write')).length === 0);
  check('restore dry-run preview expanded', (res.preview?.ops.length ?? 0) > 5);
}

// ══════════════════════════════════════════════════════════════════════
// dry-run.ts — structured write preview
// ══════════════════════════════════════════════════════════════════════

section('dry-run report — predicted writes');

{
  const ctx = await khubContext();
  const plan = planFromOps(
    [
      {
        op: 'set_keymap',
        device_selector: SEL,
        layer: 0,
        entries: [{ index: 3, value: 30 }],
      },
      {
        op: 'set_macro',
        device_selector: SEL,
        name: 'fresh',
        steps: [
          { action: 'down', key: 'KeyA', delay_ms: 0 },
          { action: 'up', key: 'KeyA', delay_ms: 30 },
        ],
        bind_key: 10,
      },
      {
        op: 'set_adv',
        device_selector: SEL,
        mode: 'mt',
        key: 3,
        tap: 4,
        hold: 30,
      },
      { op: 'set_profile_section', device_selector: SEL, section: 'sleep_seconds', value: 45 },
    ],
    ctx,
  );
  const report = buildDryRunReport(plan, { context: ctx });
  check('report ok', report.ok === true, report.validation.errors.join(';'));
  check('report covers every op', report.ops.length === plan.ops.length);
  check('totals.writes > ops', report.totals.writes > report.totals.ops, JSON.stringify(report.totals));

  const km = report.ops.find((o) => o.op === 'set_keymap');
  check('keymap predicts writeKeymap', km?.writes[0]?.method === 'writeKeymap');
  check('keymap arg is 0', km?.writes[0]?.arg === 0);

  const macro = report.ops.find((o) => o.op === 'set_macro');
  check(
    'macro predicts region + bind writes',
    macro?.writes.map((w) => w.method).join(',') === 'writeMacroRegion,writeKeymap',
    macro?.writes.map((w) => w.method).join(','),
  );
  check('macro region bytes estimated', (macro?.writes[0]?.bytes ?? 0) > 0);

  const adv = report.ops.find((o) => o.op === 'set_adv');
  check(
    'adv predicts keymap + blob writes',
    adv?.writes.map((w) => w.method).join(',') === 'writeKeyConfiguration,writeAdvKeyConfig',
  );
  check('adv blob byte count', adv?.writes[1]?.bytes === 512);

  const prof = report.ops.find((o) => o.op === 'set_profile_section');
  check('profile section predicts writeProfile', prof?.writes[0]?.method === 'writeProfile');
}

{
  // Restore expansion uses the real snapshot contents when a store is
  // supplied; without one it reports generically.
  const store = new SnapshotStore(memoryStorage());
  const src: SnapshotSource = {
    keyValues: async () => [1, 2],
    lightColorData: async () => new Uint8Array(4),
    customLightColors: async () => [],
    profile: async () => ({ raw: new Uint8Array(128) }),
    macroRegion: async () => new Uint8Array(512),
  };
  const snap = await store.capture(src, 'before');
  const ctx = await khubContext(store);
  const plan = planFromOps(
    [{ op: 'restore_snapshot', device_selector: SEL, id: snap.id }],
    ctx,
  );

  const withStore = buildDryRunReport(plan, { context: ctx, snapshots: store });
  const restore = withStore.ops[0];
  check('restore report ok', withStore.ok === true, withStore.validation.errors.join(';'));
  const kmWrite = restore?.writes.find((w) => w.method === 'writeKeymap');
  check('restore expands keymap args', kmWrite?.detail.includes('8 stored keymap set'), kmWrite?.detail);
  check(
    'restore predicts light+macro+profile writes',
    ['writeLightData', 'writeMacroRegion', 'writeProfile'].every((m) =>
      restore?.writes.some((w) => w.method === m),
    ),
    restore?.writes.map((w) => w.method).join(','),
  );

  const noStore = buildDryRunReport(plan, { context: ctx });
  check(
    'restore without store still predicts writes',
    (noStore.ops[0]?.writes.length ?? 0) > 0 &&
      noStore.ops[0]?.writes.every((w) => w.detail.includes('contents unknown')),
    noStore.ops[0]?.writes.map((w) => w.detail).join(' | '),
  );
}

{
  // A plan that fails validation still produces a report (ok:false) —
  // the UI can show WHY plus whatever predictions exist.
  const ctx = await khubContext();
  const plan = planFromOps(
    [{ op: 'set_light', device_selector: SEL, config: { mode: 277, color: '#fff' } }],
    ctx,
  );
  const report = buildDryRunReport(plan, { context: ctx });
  check('failing plan → report.ok false', report.ok === false);
  check('failing plan keeps validation errors', report.validation.errors.length > 0);
}

// ── Done ───────────────────────────────────────────────────────────────

console.log(failures === 0 ? '\nAll agent tests passed.' : `\n${failures} test(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
