/**
 * Node smoke test for `src/profile-import.ts` — the pure schema-v1 →
 * khub916 write-section planner behind the Backup & restore import
 * (bead ra1). Exercises the whole-profile round-trip mapping with a
 * recording mock writer: keymap args → layer/system split, 126-slot
 * colours, light-data + macro blobs, and the cmd-4 profile section
 * (verbatim blob AND the sleep_seconds/light_mode field patch).
 *
 * Run:  npm run smoke   (node >= 22.18, native TS type stripping)
 */

declare const process: { exit(code?: number): never };

import {
  khub916StateOfDoc,
  planProfileImport,
  type ProfileImportContext,
  type ProfileImportWriter,
} from '../src/profile-import.ts';
import type { Rgb } from '../src/proto/light.ts';

let failures = 0;
function check(name: string, cond: boolean, extra = ''): void {
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
function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

// ── Fixtures ───────────────────────────────────────────────────────────

/** K1 Pro identity — matches proto/khub916.ts CATALOG + hid.ts wired table. */
const K1_PRO: ProfileImportContext['device'] = {
  vendorId: 0x258a,
  productId: 0x010c,
  productName: 'Gaming Keyboard',
  usagePage: 0xff00,
  usage: 0,
  uuid: '0x030000000197',
  catalogModel: '916_K1_PRO',
  catalogName: 'GravaStar Mercury K1 PRO',
  screenSize: 0,
};

/** 126 live colours (slot i → distinct grey ramp) for gap filling. */
const LIVE_COLORS: Rgb[] = Array.from({ length: 126 }, (_, i) => ({
  r: i,
  g: i,
  b: i,
}));

/**
 * Plausible 128-byte profile blob: mode 5 at [9..10], sleep 30 at [24],
 * FF FF marker at 40 (table base 42) so decodeLightState/withLightMode
 * have a per-mode record for mode 5 (bright@50, packed@51).
 */
function makeProfileBlob(): Uint8Array {
  const b = new Uint8Array(128);
  b[9] = 0;
  b[10] = 5;
  b[24] = 30;
  b[40] = 0xff;
  b[41] = 0xff;
  b[50] = 12; // brightness
  b[51] = 0x17; // speed 1, type nibble 7 → mixing
  return b;
}

const CURRENT_PROFILE = makeProfileBlob();
const FILE_PROFILE = (() => {
  const b = makeProfileBlob();
  b[24] = 90; // file wants sleep 90
  b[10] = 7; // file wants light mode 7
  return b;
})();

function u32hex(n: number): string {
  return `0x${(n >>> 0).toString(16).toUpperCase().padStart(8, '0')}`;
}

/** A full schema-v1 doc shaped exactly like buildProfileExport(). */
function fullDoc(profileState: Record<string, unknown>): Record<string, unknown> {
  return {
    schema: 1,
    exported_at: '2026-01-01T00:00:00.000Z',
    host: 'omg-web',
    devices: [
      {
        protocol: 'khub916',
        vid: 0x258a,
        pid: 0x010c,
        usage_page: 0xff00,
        usage: 0,
        model: 'GravaStar Mercury K1 PRO',
        profiles: [{ name: 'current', state: profileState }],
      },
    ],
  };
}

function fullState(): Record<string, unknown> {
  return {
    device_info: { uuid: '0x030000000197', catalog_model: '916_K1_PRO' },
    keymap: {
      '0': [u32hex(0x00070004), u32hex(0x0000001e)],
      '1': [u32hex(0x00070005)],
      '4': [u32hex(0x0d000000)], // arg 4 = layer 0, system 1
      '7': [u32hex(0x0020001d)], // arg 7 = layer 3, system 1
    },
    profile: {
      bytes: FILE_PROFILE.length,
      light_mode: 7,
      sleep_seconds: 90,
      hex: hex(FILE_PROFILE),
    },
    power: { percent: 88, flags: 1 },
    light_colors: [
      { index: 0, pos: 8, r: 255, g: 0, b: 0 },
      { index: 5, pos: 28, r: 0, g: 255, b: 0 },
    ],
    light_data_hex: hex(new Uint8Array([9, 8, 7, 6, 5])),
    macro_hex: hex(new Uint8Array([1, 2, 3, 4])),
  };
}

interface Call {
  method: string;
  args: unknown[];
}

/** Recording writer — every method resolves verified unless noted. */
function mockWriter(overrides: Partial<ProfileImportWriter> = {}): {
  writer: ProfileImportWriter;
  calls: Call[];
} {
  const calls: Call[] = [];
  const rec =
    (method: string) =>
    (...args: unknown[]) => {
      calls.push({ method, args });
      return Promise.resolve({ command: 0, verified: true });
    };
  const writer: ProfileImportWriter = {
    writeKeymap: rec('writeKeymap'),
    writeCustomLightColors: rec('writeCustomLightColors'),
    writeLightData: rec('writeLightData'),
    writeMacroRegion: rec('writeMacroRegion'),
    writeProfile: rec('writeProfile'),
    ...overrides,
  };
  return { writer, calls };
}

function ctx(writer: ProfileImportWriter, extra: Partial<ProfileImportContext> = {}): ProfileImportContext {
  return {
    device: K1_PRO,
    writer,
    liveColors: LIVE_COLORS,
    currentProfile: CURRENT_PROFILE,
    ...extra,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────

section('khub916StateOfDoc');
{
  const { dev, state } = khub916StateOfDoc(fullDoc(fullState()));
  check('extracts khub916 device + state', dev.protocol === 'khub916' && state.keymap !== undefined);
  let threw = '';
  try {
    khub916StateOfDoc({ schema: 1, devices: [{ protocol: 'he-v2', profiles: [] }] });
  } catch (e) {
    threw = e instanceof Error ? e.message : String(e);
  }
  check('rejects non-khub916 backup', threw.includes('khub916'), threw);
  threw = '';
  try {
    khub916StateOfDoc({ schema: 2, devices: [] });
  } catch (e) {
    threw = e instanceof Error ? e.message : String(e);
  }
  check('rejects wrong schema', threw.includes('not a supported'), threw);
}

section('full profile → all five sections planned');
{
  const { writer, calls } = mockWriter();
  const p = planProfileImport(fullDoc(fullState()), 'backup.json', ctx(writer));
  check('no compat errors', p.compatErrors.length === 0, p.compatErrors.join('; '));
  check('no compat warnings (same model)', p.compatWarnings.length === 0, p.compatWarnings.join('; '));
  check(
    'five writable sections',
    p.sections.map((s) => s.name).join('|') ===
      'Key assignments|Per-key colours|Lighting effects|Macros|Device profile',
    p.sections.map((s) => s.name).join('|'),
  );
  check('profile snapSection', p.sections[4]?.snapSection === 'profile');
  check('keymap snapSection', p.sections[0]?.snapSection === 'keymap');

  // Apply every section through the mock writer.
  for (const s of p.sections) {
    const out = await s.apply();
    check(`${s.name} applies verified`, out.verified === true, out.text);
  }

  const kmCalls = calls.filter((c) => c.method === 'writeKeymap');
  check('keymap: 4 args written', kmCalls.length === 4, String(kmCalls.length));
  // arg → (layer, system): 0→(0,0), 1→(1,0), 4→(0,1), 7→(3,1)
  const want: [number, number, number[]][] = [
    [0, 0, [0x00070004, 0x0000001e]],
    [1, 0, [0x00070005]],
    [0, 1, [0x0d000000]],
    [3, 1, [0x0020001d]],
  ];
  want.forEach(([layer, system, values], i) => {
    const c = kmCalls[i];
    check(
      `keymap call ${i}: layer=${layer} system=${system}`,
      c !== undefined && c.args[0] === layer && c.args[1] === system,
      JSON.stringify(c?.args),
    );
    check(
      `keymap call ${i}: values match`,
      JSON.stringify(c?.args[2]) === JSON.stringify(values),
      JSON.stringify(c?.args[2]),
    );
  });

  const colCall = calls.find((c) => c.method === 'writeCustomLightColors');
  const cols = colCall?.args[0] as Rgb[] | undefined;
  check('colours: exactly 126 slots', cols?.length === 126, String(cols?.length));
  check(
    'colours: file slots win, gaps filled from live',
    cols?.[0]?.r === 255 && cols[5]?.g === 255 && cols[1]?.r === 1,
    JSON.stringify(cols?.slice(0, 6)),
  );

  const ldCall = calls.find((c) => c.method === 'writeLightData');
  check(
    'light data bytes verbatim',
    ldCall !== undefined && hex(ldCall.args[0] as Uint8Array) === '0908070605',
  );
  const mxCall = calls.find((c) => c.method === 'writeMacroRegion');
  check(
    'macro bytes verbatim',
    mxCall !== undefined && hex(mxCall.args[0] as Uint8Array) === '01020304',
  );
  const profCall = calls.find((c) => c.method === 'writeProfile');
  check(
    'profile: file blob verbatim',
    profCall !== undefined &&
      hex(profCall.args[0] as Uint8Array) === hex(FILE_PROFILE),
  );

  check(
    'read-only sections reported skipped',
    p.skipped.some((s) => s.includes('device info')) &&
      p.skipped.some((s) => s.includes('battery')),
    p.skipped.join(' | '),
  );
}

section('partial keymap export ({error} + empty args)');
{
  // error-object and empty-array args are skipped by name; the readable
  // arg still imports.
  const state = fullState();
  state.keymap = {
    '0': [u32hex(0x00070004)],
    '2': { error: 'timeout reading set' },
    '3': [],
  };
  const { writer, calls } = mockWriter();
  const p = planProfileImport(fullDoc(state), 'partial.json', ctx(writer));
  const km = p.sections.find((s) => s.name === 'Key assignments');
  check('keymap section still planned', km !== undefined);
  check(
    'error/empty args reported by name',
    p.skipped.some((s) => s.includes('key set 2')) &&
      p.skipped.some((s) => s.includes('key set 3')),
    p.skipped.join(' | '),
  );
  if (km) {
    await km.apply();
    const kmCalls = calls.filter((c) => c.method === 'writeKeymap');
    check('only the readable arg written', kmCalls.length === 1, String(kmCalls.length));
    check(
      'arg 0 → layer 0 system 0',
      kmCalls[0]?.args[0] === 0 && kmCalls[0]?.args[1] === 0,
      JSON.stringify(kmCalls[0]?.args),
    );
  }

  // An out-of-range arg is malformed → the whole section is rejected.
  const bad = fullState();
  bad.keymap = { '0': [u32hex(1)], '9': 'garbage' };
  const { writer: w2, calls: c2 } = mockWriter();
  const p2 = planProfileImport(fullDoc(bad), 'bad.json', ctx(w2));
  check(
    'out-of-range arg rejects the section',
    !p2.sections.some((s) => s.name === 'Key assignments') &&
      p2.skipped.some((s) => s.includes('key assignments')),
    p2.skipped.join(' | '),
  );
  check('nothing written for rejected section', c2.length === 0);
}

section('keymap: only error/empty args → no section');
{
  const state = fullState();
  state.keymap = { '1': { error: 'x' }, '2': [] };
  const { writer } = mockWriter();
  const p = planProfileImport(fullDoc(state), 'e.json', ctx(writer));
  check('no keymap section', !p.sections.some((s) => s.name === 'Key assignments'));
  check(
    'both args skipped by name',
    p.skipped.filter((s) => s.includes('key set')).length === 2,
    p.skipped.join(' | '),
  );
}

section('profile: field-patch path (no hex in file)');
{
  const state = fullState();
  state.profile = { bytes: 128, light_mode: 7, sleep_seconds: 90 };
  const { writer, calls } = mockWriter();
  const p = planProfileImport(fullDoc(state), 'fields.json', ctx(writer));
  const prof = p.sections.find((s) => s.name === 'Device profile');
  check('profile section planned from fields', prof !== undefined, p.skipped.join(' | '));
  check(
    'summary names the fields',
    prof?.summary.includes('sleep 90') === true && prof.summary.includes('mode 7'),
    prof?.summary,
  );
  if (prof) await prof.apply();
  const call = calls.find((c) => c.method === 'writeProfile');
  const blob = call?.args[0] as Uint8Array | undefined;
  check('writeProfile called once', call !== undefined);
  check(
    'sleep patched at byte 24',
    blob !== undefined && blob.length === CURRENT_PROFILE.length && blob[24] === 90,
  );
  check(
    'light mode patched at bytes 9..10',
    blob !== undefined && blob[9] === 0 && blob[10] === 7,
  );
  check(
    'untouched bytes preserved',
    blob !== undefined && blob[50] === CURRENT_PROFILE[50] && blob[40] === 0xff,
  );
}

section('profile: strict guards');
{
  // Length mismatch vs connected device → skipped, no section.
  const state = fullState();
  const short = new Uint8Array(64);
  short.set([0x41], 0);
  state.profile = { bytes: 64, hex: hex(short) };
  const { writer } = mockWriter();
  const p = planProfileImport(fullDoc(state), 'mismatch.json', ctx(writer));
  check(
    'mismatched blob length skipped',
    !p.sections.some((s) => s.name === 'Device profile') &&
      p.skipped.some((s) => s.includes('different firmware layout')),
    p.skipped.join(' | '),
  );

  // No currentProfile + no hex → field patch impossible → skipped.
  const state2 = fullState();
  state2.profile = { sleep_seconds: 42 };
  const p2 = planProfileImport(fullDoc(state2), 'noprof.json', ctx(writer, { currentProfile: undefined }));
  check(
    'field patch without device blob skipped',
    !p2.sections.some((s) => s.name === 'Device profile') &&
      p2.skipped.some((s) => s.includes('no readable device')),
    p2.skipped.join(' | '),
  );

  // Corrupt hex + valid fields → verbatim refused, fields still patched.
  const state4 = fullState();
  state4.profile = { bytes: 128, hex: 'zz', sleep_seconds: 77 };
  const { writer: w4, calls: c4 } = mockWriter();
  const p4 = planProfileImport(fullDoc(state4), 'badhex.json', ctx(w4));
  const prof4 = p4.sections.find((s) => s.name === 'Device profile');
  check(
    'bad hex falls back to field patch',
    prof4 !== undefined && p4.skipped.some((s) => s.includes('unreadable hex')),
    `${p4.sections.map((s) => s.name)} | ${p4.skipped.join(' | ')}`,
  );
  if (prof4) {
    await prof4.apply();
    const blob = c4.find((c) => c.method === 'writeProfile')?.args[0] as Uint8Array;
    check('patched blob keeps device layout', blob[24] === 77 && blob.length === 128);
  }

  // Out-of-range field values rejected even if validateProfileJson was bypassed.
  const state3 = fullState();
  state3.profile = { sleep_seconds: 300, light_mode: 9 };
  const { writer: w3, calls: c3 } = mockWriter();
  const p3 = planProfileImport(fullDoc(state3), 'badfields.json', ctx(w3));
  check(
    'invalid sleep skipped, valid mode still patched',
    p3.sections.some((s) => s.name === 'Device profile') &&
      p3.skipped.some((s) => s.includes('sleep_seconds')),
    `${p3.sections.map((s) => s.name)} | ${p3.skipped.join(' | ')}`,
  );
  if (p3.sections.length) {
    for (const s of p3.sections) await s.apply();
    const blob = c3.find((c) => c.method === 'writeProfile')?.args[0] as Uint8Array;
    check('only light mode applied', blob[24] === CURRENT_PROFILE[24] && blob[10] === 9);
  }
}

section('capability gaps → honest pending skips');
{
  const { writer } = mockWriter({ writeProfile: undefined, writeMacroRegion: undefined });
  const p = planProfileImport(fullDoc(fullState()), 'x.json', ctx(writer));
  check(
    'missing writers reported pending',
    p.skipped.some((s) => s.startsWith('macros') && s.includes('not available')) &&
      p.skipped.some((s) => s.startsWith('device profile') && s.includes('not available')),
    p.skipped.join(' | '),
  );
  check(
    'other sections still planned',
    p.sections.some((s) => s.name === 'Key assignments') &&
      p.sections.some((s) => s.name === 'Device profile') === false,
  );
}

section('compatibility gate');
{
  // Non-khub916 device → compatErrors block.
  const { writer } = mockWriter();
  const alien = ctx(writer, {
    device: { vendorId: 0x1234, productId: 0x5678, productName: 'other' },
  });
  const p = planProfileImport(fullDoc(fullState()), 'alien.json', alien);
  check('protocol mismatch is a compat error', p.compatErrors.length > 0, p.compatErrors.join('; '));

  // Same protocol, different model → warning only.
  const otherModel = ctx(writer, {
    device: { ...K1_PRO, catalogModel: '916_K98Pro', catalogName: 'K98', uuid: '0x0600000000b3' },
  });
  const p2 = planProfileImport(fullDoc(fullState()), 'model.json', otherModel);
  check('model mismatch is a warning', p2.compatErrors.length === 0 && p2.compatWarnings.length > 0,
    `${p2.compatErrors} / ${p2.compatWarnings}`);
}

section('unverified write outcome propagates');
{
  const { writer } = mockWriter({
    writeProfile: () => Promise.resolve({ command: 4, verified: false }),
  });
  const p = planProfileImport(fullDoc(fullState()), 'u.json', ctx(writer));
  const prof = p.sections.find((s) => s.name === 'Device profile');
  const out = prof ? await prof.apply() : null;
  check('verified:false surfaces', out !== null && out.verified === false);
}

// ── Done ───────────────────────────────────────────────────────────────

if (failures > 0) {
  console.error(`\n${failures} check(s) FAILED`);
  process.exit(1);
}
console.log('\nsmoke-import: all checks passed');
