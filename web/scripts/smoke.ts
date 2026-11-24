/**
 * Node smoke test for the pure khub916 protocol functions.
 *
 * Mirrors the fixtures in `crates/proto-khub916/src/lib.rs` tests and
 * `docs/protocol-khub916.md` §5 (live-verified on K1 Pro). Run:
 *   npm run smoke   (node >= 22.18, native TS type stripping)
 */

declare const process: { exit(code?: number): never };

import {
  CMD,
  CUSTOM_LIGHT_ENTRIES,
  FEATURE_PAYLOAD_BYTES,
  HEADER_LEN,
  buildPacket,
  catalogLookup,
  decodeKeyValue,
  echoMatches,
  hidUsageLabel,
  keyValueLabel,
  keyValueLabelOf,
  parseCustomLightColors,
  parseDeviceInfo,
  parseKeyValues,
  parsePower,
  parseProfile,
  queryPacket,
  responsePayload,
  uuidHex,
} from '../src/proto/khub916.ts';

import {
  buildMacroRegion,
  decodeStep,
  encodeStep,
  macroFreeSpace,
  macroKeyValue,
  macroNameForUsage,
  macroSpaceNeeded,
  macroUsageForName,
  defaultKindForName,
  padMacroRegion,
  parseMacroRegion,
  parseStepsJson,
  MACRO_REGION_BYTES,
  MAX_STEP_DURATION,
  type MacroEntry,
  type MacroStep,
  type StepKind,
} from '../src/proto/macro916.ts';
import { keymapWritePacket, keymapWritePayload, macroWritePacket } from '../src/proto/khub916.ts';

let failures = 0;
function check(name: string, cond: boolean, extra = ''): void {
  if (cond) {
    console.log(`  ok  ${name}`);
  } else {
    failures++;
    console.error(`FAIL  ${name} ${extra}`);
  }
}
function eq<T>(a: T, b: T): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ── Packet layout (spec §2, live fixture headers §5) ───────────────────

const INFO_HEADER = [0x82, 0x01, 0x00, 0x01, 0x00, 0x0a, 0x00];
{
  const pkt = queryPacket(CMD.deviceInfo, 0x01, 0x0a, 0x00);
  check('packet is 519 bytes', pkt.length === FEATURE_PAYLOAD_BYTES);
  check('device-info header matches live fixture', eq([...pkt.slice(0, 7)], INFO_HEADER));
  check('packet tail zero-padded', pkt.slice(7).every((b) => b === 0));

  const p2 = buildPacket(0x03, 0x00, 0xf8, 0x01, new Uint8Array([1, 2, 3]));
  check(
    'keymap-write header',
    eq([...p2.slice(0, 7)], [0x03, 0x00, 0x00, 0x01, 0x00, 0xf8, 0x01]),
  );
  check('payload at offset 7', eq([...p2.slice(7, 10)], [1, 2, 3]));

  let threw = false;
  try {
    buildPacket(3, 0, 0xf8, 0x01, new Uint8Array(600));
  } catch {
    threw = true;
  }
  check('oversize payload refused', threw);
}

// ── Device info (live K1 Pro fixture §5) ───────────────────────────────

{
  const resp = new Uint8Array([
    ...INFO_HEADER,
    0x03, 0x00, 0x00, 0x00, 0x01, 0x97, // uuid
    0x01, 0x00, // version 0x0100
    0x00, // screen size
  ]);
  const payload = responsePayload(resp);
  check('echo matches', echoMatches(queryPacket(CMD.deviceInfo, 0x01, 0x0a, 0x00), resp));
  const info = parseDeviceInfo(payload);
  check('uuid', info.uuid === '0x030000000197', info.uuid);
  check('version', info.version === 0x0100);
  check('screen none', info.screen === null && info.screenSize === 0);
  check('catalog model', info.catalogModel === '916_K1_PRO');
  check('catalog name', info.catalogName === 'GravaStar Mercury K1 PRO');

  const unknown = parseDeviceInfo(
    new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x00, 0x01, 0x02, 0x00, 0x04]),
  );
  check('unknown uuid no catalog', unknown.catalogModel === null);
  check('screen size 4 → 240×240', eq(unknown.screen, [240, 240]));
}

// ── Power (live fixture §5) ────────────────────────────────────────────

{
  const power = parsePower(new Uint8Array([0x64, 0x11]));
  check('power 100%', power.percent === 100 && power.flags === 0x11);
}

// ── Keymap decode (live prefix §5 + tag cases) ─────────────────────────

{
  const raw = new Uint8Array();
  const vals = [0x00000029, 0x00000035, 0x0000002b, 0x00000039];
  const bytes = new Uint8Array(vals.length * 4);
  vals.forEach((v, i) => bytes.set([(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff], i * 4));
  void raw;
  const keys = parseKeyValues(bytes);
  check('keymap u32 count', keys.length === 4);
  check('keymap labels', eq(keys.map(keyValueLabelOf), ['Esc', '`', 'Tab', 'Caps']), keys.map(keyValueLabelOf).join(','));

  const labels: [number, string][] = [
    [0x00000000, ''],
    [0x0002001e, 'Shift+1'],
    [0x00040029, 'Alt+Esc'],
    [0x0d000000, 'Fn'],
    [0x0d010000, 'Fn1'],
    [0x03011234, 'Macro(1,18,52)'],
    [0x20deadbe, 'SOCD'],
    [0x21000001, 'MT'],
    [0x22000002, 'TGL'],
    [0xdeadbeef, '0xDEADBEEF'],
  ];
  for (const [v, want] of labels) {
    check(`label 0x${v.toString(16)}`, keyValueLabelOf(v) === want, `got "${keyValueLabelOf(v)}"`);
  }
  const kv = decodeKeyValue(0x0002001e);
  check('decode normal+shift', kv.kind === 'normal' && kv.shift && kv.usage === 0x1e);
}

// ── Profile / custom light (spec §6) ───────────────────────────────────

{
  const prof = new Uint8Array(128);
  prof[9] = 0x01;
  prof[10] = 0x02;
  prof[24] = 30;
  const p = parseProfile(prof);
  check('profile light mode', p.lightMode === 0x0102, String(p.lightMode));
  check('profile sleep', p.sleepSeconds === 30);

  const payload = new Uint8Array(CUSTOM_LIGHT_ENTRIES * 3);
  payload[0] = 0x11;
  payload[CUSTOM_LIGHT_ENTRIES] = 0x22;
  payload[2 * CUSTOM_LIGHT_ENTRIES] = 0x33;
  payload[1] = 0x44;
  payload[CUSTOM_LIGHT_ENTRIES + 1] = 0x55;
  payload[2 * CUSTOM_LIGHT_ENTRIES + 1] = 0x66;
  const colors = parseCustomLightColors(payload);
  check('light count', colors.length === CUSTOM_LIGHT_ENTRIES);
  check(
    'light planes',
    colors[0]?.r === 0x11 && colors[0]?.g === 0x22 && colors[0]?.b === 0x33 && colors[0]?.pos === 8,
  );
  check(
    'light entry 1',
    colors[1]?.pos === 12 && colors[1]?.r === 0x44 && colors[1]?.g === 0x55 && colors[1]?.b === 0x66,
  );
}

// ── Catalog ────────────────────────────────────────────────────────────

{
  check('catalog K1 Pro', catalogLookup('0x030000000197')?.model === '916_K1_PRO');
  check('catalog case-insensitive', catalogLookup('0x0300000001B4')?.name === 'GravaStar Mercury K1');
  check('catalog miss', catalogLookup('0xdeadbeef0001') === undefined);
  check('uuidHex', uuidHex(new Uint8Array([0x03, 0, 0, 0, 0x01, 0x97])) === '0x030000000197');
  check('usage label fallback', hidUsageLabel(0x999) === '999');
}

// ── Macro region codec (port of crates/proto-khub916/src/macro916.rs) ──

function step(action: number, delay: number, usage: number, kind: StepKind): MacroStep {
  return { action, delayMs: delay, usage, kind };
}

{
  // Exact wire bytes — mirrors the Rust `single_macro_wire_bytes` test.
  const entries: MacroEntry[] = [
    { name: 'A', steps: [step(0, 8, 4, 'key'), step(1, 0, 4, 'key')] },
  ];
  const region = buildMacroRegion(entries);
  const want = [
    0x04, 0x00, 0x0a, 0x00, 0x01, 0x41, 0x00, 0x00, 0x08, 0x04, 0x80, 0x00, 0x00, 0x04,
  ];
  check('macro region wire bytes', eq([...region], want), [...region].join(','));
  check('macro region length', region.length === 14);

  const parsed = parseMacroRegion(padMacroRegion(region));
  check('macro parse count', parsed.length === 1);
  check('macro parse name', parsed[0]?.name === 'A');
  check('macro parse steps', parsed[0]?.steps.length === 2);
  check(
    'macro step roundtrip',
    eq(parsed[0]?.steps[0], step(0, 8, 4, 'key')),
    JSON.stringify(parsed[0]?.steps[0]),
  );
}

{
  // Multi-entry offsets — mirrors `multi_entry_offsets`.
  const entries: MacroEntry[] = [
    { name: 'a', steps: [step(0, 1, 1, 'key')] },
    { name: 'bb', steps: [] },
  ];
  const region = buildMacroRegion(entries);
  const u16 = (i: number) => (region[i] ?? 0) | ((region[i + 1] ?? 0) << 8);
  check('multi offsets h0', u16(0) === 8 && u16(2) === 6);
  check('multi offsets h1', u16(4) === 14 && u16(6) === 3);
  const parsed = parseMacroRegion(padMacroRegion(region));
  check('multi parse', parsed.length === 2 && parsed[1]?.name === 'bb' && parsed[1]?.steps.length === 0);
}

{
  // Kind nibbles + unknown nibble preservation — mirrors `modifier_and_mouse_nibbles`.
  check('modifier down nibble', (encodeStep(step(0, 0, 225, 'modifier'))[0] ?? 0) >> 4 === 1);
  check('modifier up nibble', (encodeStep(step(1, 0, 225, 'modifier'))[0] ?? 0) >> 4 === 9);
  check('mouse down nibble', (encodeStep(step(0, 0, 1, 'mouse'))[0] ?? 0) >> 4 === 2);
  check('mouse up nibble', (encodeStep(step(1, 0, 1, 'mouse'))[0] ?? 0) >> 4 === 10);
  const s = decodeStep(new Uint8Array([0xb0, 0, 0, 7]));
  check('other nibble decode', s.kind === 11 && s.action === 0);
  const rt = encodeStep({ ...s, action: 1 });
  check('other nibble roundtrip', (rt[0] ?? 0) >> 4 === 11);
  const sm = decodeStep(new Uint8Array([0x10, 0, 0, 225]));
  check('modifier decode', sm.action === 0 && sm.kind === 'modifier');
}

{
  // 20-bit duration — mirrors `duration_is_20bit`.
  const b = encodeStep(step(0, 0xabcde, 30, 'key'));
  check('duration hi nibble', ((b[0] ?? 0) & 0x0f) === 0xa);
  check('duration mid', b[1] === 0xbc && b[2] === 0xde);
  check('duration decode', decodeStep(b).delayMs === 0xabcde);
  let overMax = false;
  try {
    encodeStep(step(0, MAX_STEP_DURATION + 1, 1, 'key'));
  } catch {
    overMax = true;
  }
  check('duration over 20-bit rejected', overMax);

  // Oversize region / long name rejected — mirrors `build_rejects_oversize`.
  const big: MacroEntry = { name: 'x', steps: Array.from({ length: 120 }, () => step(0, 0, 1, 'key')) };
  let threw = false;
  try {
    buildMacroRegion([big, big]);
  } catch {
    threw = true;
  }
  check('oversize region rejected', threw);
  threw = false;
  try {
    buildMacroRegion([{ name: 'n'.repeat(256), steps: [] }]);
  } catch {
    threw = true;
  }
  check('long name rejected', threw);
}

{
  // Free space + key value + name table — mirrors the remaining Rust tests.
  const r = new Uint8Array([1, 2, 3, 4, ...new Array(100).fill(0)]);
  check('free space run', macroFreeSpace(r) === 100);
  check('free space none', macroFreeSpace(new Uint8Array([1, 2, 3, 0, 1, 2, 3, 0])) === 0);
  check('free space all zero', macroFreeSpace(new Uint8Array(MACRO_REGION_BYTES)) === MACRO_REGION_BYTES);
  check('key value', macroKeyValue(1, 1, 0) === 0x03010100 && macroKeyValue(1, 2, 255) === 0x030102ff);
  check('space needed', macroSpaceNeeded('jump', 4) === 5 + 4 + 16);
  check('usage for name', macroUsageForName('KeyA') === 4 && macroUsageForName('MouseLeft') === 1);
  check('name for usage', macroNameForUsage(4, 'key') === 'KeyA');
  check('mouse special', macroNameForUsage(8, 'mouse') === 'MouseForward' && macroNameForUsage(8, 'key') === 'KeyE');
  check('kind defaults', defaultKindForName('ShiftLeft') === 'modifier' && defaultKindForName('MouseRight') === 'mouse' && defaultKindForName('KeyA') === 'key');

  // Empty/garbage regions parse empty — mirrors `empty_region_parses_empty`.
  check('empty region', parseMacroRegion(new Uint8Array(0)).length === 0);
  check('zero region', parseMacroRegion(new Uint8Array(MACRO_REGION_BYTES)).length === 0);
  check('short r region', parseMacroRegion(new Uint8Array([2, 0, 0, 0])).length === 0);
  check('odd r region', parseMacroRegion(new Uint8Array([3, 0, 0, 0, 0, 0, 0, 0])).length === 0);

  // Full roundtrip incl. modifier + mouse steps.
  const entries2: MacroEntry[] = [
    {
      name: 'hello',
      steps: [
        step(0, 8, 4, 'key'),
        step(1, 120, 4, 'key'),
        step(0, 0, 225, 'modifier'),
        step(1, 0, 1, 'mouse'),
      ],
    },
    { name: 'second', steps: [step(0, 1000, 30, 'key')] },
  ];
  const rt = parseMacroRegion(padMacroRegion(buildMacroRegion(entries2)));
  check(
    'full roundtrip',
    rt.length === 2 &&
      rt[0]?.name === 'hello' &&
      rt[0]?.steps.length === 4 &&
      rt[0]?.steps[2]?.kind === 'modifier' &&
      rt[0]?.steps[3]?.kind === 'mouse' &&
      rt[1]?.steps[0]?.delayMs === 1000,
    JSON.stringify(rt),
  );

  // Steps JSON import (docs/macro-schema.md).
  const imported = parseStepsJson(
    '{"name":"jump","steps":[{"action":"down","key":"ShiftLeft","delay_ms":8},{"action":"down","key":"KeyB","delay_ms":0},{"action":"up","key":"KeyB","delay_ms":50},{"action":"up","key":"ShiftLeft","delay_ms":0}]}',
  );
  check('json import name', imported.name === 'jump');
  check(
    'json import steps',
    imported.steps.length === 4 &&
      imported.steps[0]?.usage === 225 &&
      imported.steps[0]?.kind === 'modifier' &&
      imported.steps[1]?.usage === 5 &&
      imported.steps[2]?.action === 1 &&
      imported.steps[2]?.delayMs === 50,
    JSON.stringify(imported.steps),
  );
  const bare = parseStepsJson('[{"action":"press","key":"0x04","delay_ms":8}]');
  check('json bare array + hex key', bare.name === null && bare.steps[0]?.usage === 4 && bare.steps[0]?.action === 0);
  let bad = false;
  try {
    parseStepsJson('{"steps":[{"action":"down","key":"Fn"}]}');
  } catch {
    bad = true;
  }
  check('json Fn rejected', bad);
}

{
  // Write packets — mirror `write_keymap` / `write_macro_region` layout.
  const kp = keymapWritePacket(1, 0, [0x03010100, 0x00000029]);
  check('keymap write header', eq([...kp.slice(0, 7)], [3, 1, 0, 1, 0, 0xf8, 0x01]));
  check('keymap write be u32', kp[7] === 0x03 && kp[8] === 0x01 && kp[9] === 0x01 && kp[10] === 0x00 && kp[11] === 0x00 && kp[14] === 0x29);
  const kpl = keymapWritePayload([0x03010100]);
  check('keymap payload 512', kpl.length === 512 && kpl[510] === 0x5a && kpl[511] === 0xa5);
  const mp = macroWritePacket(new Uint8Array([1, 2, 3]));
  check('macro write header', eq([...mp.slice(0, 7)], [5, 0, 0, 1, 0, 0, 0]));
  check('macro write payload', mp.length === 519 && mp[7] === 1 && mp[9] === 3 && mp[10] === 0);
}

console.log(failures === 0 ? '\nAll smoke checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
