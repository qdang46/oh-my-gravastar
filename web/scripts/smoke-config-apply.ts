/**
 * Smoke test for web/src/config-apply.ts — the desired-state → PlannedOp
 * lowering behind the Custom config page's guided apply. Uses a mock
 * ConfigSession (no HID). Verifies the capability gate mirrors the Rust
 * `plan_sections`, semantic conflict checks fire, and lowered ops produce
 * the right writeKeymap/writeMacroRegion/writeProfile calls.
 * Run: `npm run smoke` (chained) — plain Node TS runner, no test deps.
 */

declare const process: { exit(code?: number): never };

import {
  planConfigSections,
  configSemanticErrors,
  configToOps,
  type ConfigSession,
} from '../src/config-apply.ts';
import { macroKeyValue } from '../src/proto/macro916.ts';

const KHUB = { protocol: 'khub916', vid: 0x1e7d, pid: 0xf501 };

function doc(sections: Record<string, unknown>): Record<string, unknown> {
  return { schema_version: 1, device: KHUB, ...sections };
}

let failures = 0;
function check(name: string, cond: boolean, extra = ''): void {
  if (cond) {
    console.log(`  ok  ${name}`);
  } else {
    failures++;
    console.error(`  FAIL ${name} ${extra}`);
  }
}

// ── planConfigSections mirrors crates/omg/src/config.rs plan_sections ──

{
  const p = planConfigSections(doc({ keymap: { mode: 'patch' } }));
  check('khub916 keymap patch planned', p[0]!.status === 'planned');
}
{
  const p = planConfigSections(doc({ lighting: {}, advanced_keys: {} }));
  check(
    'khub916 lighting/advanced_keys not_applied',
    p.every((s) => s.status === 'not_applied') && /not yet wired/.test(p[0]!.detail),
  );
}
{
  const p = planConfigSections({
    schema_version: 1,
    device: { protocol: 'compx', vid: 1, pid: 2 },
    settings: { mode: 'patch' },
  });
  check(
    'compx patch rejected',
    p[0]!.status === 'not_applied' && /read-merge/.test(p[0]!.detail),
  );
}
{
  let gated = true;
  for (const protocol of ['he-v2', 'sparkplayjoy']) {
    const p = planConfigSections({
      schema_version: 1,
      device: { protocol, vid: 1, pid: 2 },
      settings: {},
    });
    if (p[0]!.status !== 'not_applied') gated = false;
  }
  check('he-v2 and sparkplayjoy gated', gated);
}

// ── configSemanticErrors ──

{
  const errs = configSemanticErrors(
    doc({
      keymap: {
        mode: 'patch', layer: 0, system: 0,
        entries: [
          { index: 3, value: '0x1' },
          { index: 3, value: '0x2' },
        ],
      },
    }),
  );
  check('duplicate patch index flagged', errs.some((e) => e.includes('duplicate index 3')));
}
{
  const errs = configSemanticErrors(
    doc({
      keymap: { mode: 'patch', layer: 0, system: 0, entries: [{ index: 5, value: '0x1' }] },
      macros: [{
        index: 'next', steps: [{ action: 'down', key: 'KeyA' }],
        bind: { layer: 0, system: 0, key: 5, macro_type: 1, loop_count: 1 },
      }],
    }),
  );
  check('keymap vs macro bind slot conflict flagged', errs.some((e) => e.includes('slot conflict')));
}
{
  const errs = configSemanticErrors(
    doc({
      keymap: { mode: 'patch', layer: 0, system: 0, entries: [{ index: 5, value: '0x1' }] },
      macros: [{
        index: 'next', steps: [{ action: 'down', key: 'KeyA' }],
        bind: { layer: 0, system: 0, key: 6, macro_type: 1, loop_count: 1 },
      }],
    }),
  );
  check('non-conflicting bind is clean', errs.length === 0);
}

// ── configToOps + mock session ──

interface MockSession extends ConfigSession {
  calls: {
    writeKeymap: unknown[][];
    writeMacroRegion: number;
    writeProfile: number;
  };
}

function mockSession(over: Partial<ConfigSession> = {}): MockSession {
  const calls = { writeKeymap: [] as unknown[][], writeMacroRegion: 0, writeProfile: 0 };
  return {
    calls,
    keyValues: async () => [0x01000000, 0x02000000, 0x03000000],
    writeKeymap: async (l: number, s: number, v: readonly number[]) => {
      calls.writeKeymap.push([l, s, ...v]);
      return { verified: true };
    },
    macroRegion: async () => new Uint8Array(512),
    writeMacroRegion: async () => {
      calls.writeMacroRegion++;
      return { verified: true };
    },
    profile: async () => ({ raw: new Uint8Array(128) }),
    writeProfile: async () => {
      calls.writeProfile++;
      return { verified: true };
    },
    ...over,
  };
}

{
  const s = mockSession();
  const ops = configToOps(
    doc({
      keymap: {
        mode: 'patch', layer: 1, system: 0,
        entries: [{ index: 1, value: '0xA5' }],
      },
    }),
    s,
  );
  check('keymap patch → one keymap_write op', ops.length === 1 && ops[0]!.type === 'keymap_write');
  await ops[0]!.apply();
  const call = s.calls.writeKeymap[0]!;
  check(
    'patch edits only the targeted slot',
    call[0] === 1 && call[1] === 0 && call[2] === 0x01000000 && call[3] === 0xa5,
    JSON.stringify(call),
  );
}

{
  const s = mockSession();
  const ops = configToOps(
    doc({ keymap: { mode: 'replace', layer: 0, system: 0, values: ['0x1', '0x2'] } }),
    s,
  );
  let threw = '';
  try {
    await ops[0]!.apply();
  } catch (e) {
    threw = e instanceof Error ? e.message : String(e);
  }
  check(
    'keymap replace length mismatch throws before write',
    /reports 3 slots/.test(threw) && s.calls.writeKeymap.length === 0,
    threw,
  );
}

{
  const s = mockSession();
  const ops = configToOps(
    doc({
      macros: [{
        index: 'next',
        name: 'hi',
        steps: [{ action: 'down', delay_ms: 10, key: 'KeyA' }],
        bind: { layer: 0, system: 0, key: 2, macro_type: 1, loop_count: 1 },
      }],
    }),
    s,
  );
  check('macros → one macro_write op', ops.length === 1 && ops[0]!.type === 'macro_write');
  await ops[0]!.apply();
  const call = s.calls.writeKeymap[0];
  check(
    'macro bind writes tag-3 value at key slot',
    s.calls.writeMacroRegion === 1 &&
      s.calls.writeKeymap.length === 1 &&
      call !== undefined &&
      call[4] === macroKeyValue(1, 1, 0),
    JSON.stringify(call),
  );
}

{
  const s = mockSession();
  const ops = configToOps(doc({ settings: { sleep_seconds: 42 } }), s);
  check(
    'settings.sleep_seconds → one settings_write op',
    ops.length === 1 && ops[0]!.type === 'settings_write',
  );
  await ops[0]!.apply();
  check('sleep writes profile blob', s.calls.writeProfile === 1);
}

{
  const ops = configToOps(
    {
      schema_version: 1,
      device: { protocol: 'compx', vid: 1, pid: 2 },
      settings: { mode: 'replace' },
    },
    mockSession(),
  );
  check('non-khub916 doc produces no ops', ops.length === 0);
}

// ── Safety regressions (review P0/P1) ──

{
  const errs = configSemanticErrors(
    doc({
      macros: [
        { index: 2, steps: [{ action: 'down', key: 'KeyA' }] },
        { index: 2, steps: [{ action: 'down', key: 'KeyB' }] },
      ],
    }),
  );
  check('duplicate macro index flagged', errs.some((e) => e.includes('duplicate index 2')));
}

{
  // A bind that fails preflight must abort BEFORE the region write.
  const s = mockSession();
  const ops = configToOps(
    doc({
      macros: [{
        index: 'next',
        steps: [{ action: 'down', key: 'KeyA' }],
        bind: { layer: 0, system: 0, key: 99, macro_type: 1, loop_count: 1 },
      }],
    }),
    s,
  );
  let threw = '';
  try {
    await ops[0]!.apply();
  } catch (e) {
    threw = e instanceof Error ? e.message : String(e);
  }
  check(
    'bad bind preflight aborts before region write',
    /out of range/.test(threw) &&
      s.calls.writeMacroRegion === 0 &&
      s.calls.writeKeymap.length === 0,
    `${threw} writes=${s.calls.writeMacroRegion}`,
  );
}

{
  // Duplicate resolved slots ("next" colliding with an explicit index of
  // the append position) must be rejected before any write.
  const s = mockSession();
  const ops = configToOps(
    doc({
      macros: [
        { index: 'next', steps: [{ action: 'down', key: 'KeyA' }] },
        { index: 0, steps: [{ action: 'down', key: 'KeyB' }] },
      ],
    }),
    s,
  );
  // Empty region → "next" resolves to 0, same as explicit index 0.
  let threw = '';
  try {
    await ops[0]!.apply();
  } catch (e) {
    threw = e instanceof Error ? e.message : String(e);
  }
  check(
    'duplicate resolved slot rejected before write',
    /duplicate resolved index/.test(threw) && s.calls.writeMacroRegion === 0,
    threw,
  );
}

{
  // Unverified region write must not be followed by bind writes.
  const s = mockSession({
    writeMacroRegion: async () => {
      s.calls.writeMacroRegion++;
      return { verified: false };
    },
  });
  const ops = configToOps(
    doc({
      macros: [{
        index: 'next',
        steps: [{ action: 'down', key: 'KeyA' }],
        bind: { layer: 0, system: 0, key: 1, macro_type: 1, loop_count: 1 },
      }],
    }),
    s,
  );
  const out = await ops[0]!.apply();
  check(
    'unverified region write skips binds',
    out.verified === false && s.calls.writeKeymap.length === 0,
  );
}

if (failures) {
  console.error(`smoke-config-apply: ${failures} failure(s)`);
  process.exit(1);
}
console.log('smoke-config-apply: all checks passed');
