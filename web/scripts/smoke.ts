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

console.log(failures === 0 ? '\nAll smoke checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
