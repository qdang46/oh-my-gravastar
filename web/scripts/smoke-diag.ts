/**
 * Node smoke test for `src/diag-core.ts` — the DOM-free helpers behind
 * the Diagnostics page (bead `oq2`): boot keyboard report decoding and
 * khub916 keymap-value → press-token mapping. Run:
 *   npm run smoke   (node >= 22.18, native TS type stripping)
 */

declare const process: { exit(code?: number): never };

import {
  decodeBootKeyboardReport,
  hexBytes,
  MODIFIER_LABELS,
  pressTokensForValue,
} from '../src/diag-core.ts';

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

console.log('diag-core: decodeBootKeyboardReport');

// Empty report: no modifiers, no keys.
{
  const r = decodeBootKeyboardReport(new Uint8Array(8));
  check('empty report decodes', r !== null);
  check('empty modifiers', r?.modifiers === 0);
  check('empty usages', eq(r?.usages, []));
  check('empty mod usages', eq(r?.modUsages, []));
}

// 'A' key (usage 0x04) in slot 0, rest empty.
{
  const r = decodeBootKeyboardReport(new Uint8Array([0, 0, 0x04, 0, 0, 0, 0, 0]));
  check('A key usage', eq(r?.usages, [0x04]));
}

// Left Ctrl held + 'S' (0x16): modifier bit0 → usage 0xE0.
{
  const r = decodeBootKeyboardReport(new Uint8Array([0x01, 0, 0x16, 0, 0, 0, 0, 0]));
  check('LCtrl modifier usage', eq(r?.modUsages, [0xe0]));
  check('LCtrl + S usages', eq(r?.usages, [0x16]));
}

// All eight modifier bits.
{
  const r = decodeBootKeyboardReport(new Uint8Array([0xff, 0, 0, 0, 0, 0, 0, 0]));
  check(
    'all modifiers map to 0xE0..0xE7',
    eq(r?.modUsages, [0xe0, 0xe1, 0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7]),
  );
}

// Six-key rollover fills all slots; zero slots are skipped.
{
  const r = decodeBootKeyboardReport(
    new Uint8Array([0, 0, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09]),
  );
  check('six keys decoded', eq(r?.usages, [4, 5, 6, 7, 8, 9]));
}

// Non-boot lengths are rejected (NKRO / vendor frames).
for (const len of [0, 1, 7, 9, 16, 64]) {
  check(`length ${len} rejected`, decodeBootKeyboardReport(new Uint8Array(len)) === null);
}

console.log('diag-core: pressTokensForValue');

// Plain key: value 0x04 ('A') → usage token only.
check('plain A → [0x04]', eq(pressTokensForValue(0x04), [0x04]));

// Modifier-only value 0x10000 (L_Ctrl: usage 0 + ctrl bit) → [0xE0].
check('L_Ctrl → [0xE0]', eq(pressTokensForValue(0x10000), [0xe0]));

// L_shift 0x20000, L_Alt 0x40000, L_WIN 0x80000.
check('L_shift → [0xE1]', eq(pressTokensForValue(0x20000), [0xe1]));
check('L_Alt → [0xE2]', eq(pressTokensForValue(0x40000), [0xe2]));
check('L_WIN → [0xE3]', eq(pressTokensForValue(0x80000), [0xe3]));

// Chord Ctrl+Shift+'A' = 0x00030004 → usage + both modifiers.
check(
  'Ctrl+Shift+A → [0x04,0xE0,0xE1]',
  eq(pressTokensForValue(0x00030004), [0x04, 0xe0, 0xe1]),
);

// Non-normal kinds produce no tokens (cannot match a physical press).
check('empty value → []', eq(pressTokensForValue(0), []));
check('Fn (0x0D…) → []', eq(pressTokensForValue(0x0d000001), []));
check('macro (0x03…) → []', eq(pressTokensForValue(0x03000001), []));
check('SOCD (0x20…) → []', eq(pressTokensForValue(0x20000001), []));

console.log('diag-core: labels / hex');
check('modifier labels cover 0xE0..0xE7', Object.keys(MODIFIER_LABELS).length === 8);
check('hexBytes short', hexBytes(new Uint8Array([0xab, 0x01])) === 'ab 01');
check('hexBytes truncates', hexBytes(new Uint8Array(200), 4).endsWith('…'));

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall diag-core checks passed');
