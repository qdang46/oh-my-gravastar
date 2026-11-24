/**
 * Node smoke test for `src/diag-core.ts` — the DOM-free helpers behind
 * the Diagnostics page (bead `oq2`): boot keyboard report decoding and
 * khub916 keymap-value → press-token mapping. Run:
 *   npm run smoke   (node >= 22.18, native TS type stripping)
 */

declare const process: { exit(code?: number): never };

import {
  bootPressedUsages,
  ChatterTracker,
  decodeBootKeyboardReport,
  hexBytes,
  MODIFIER_LABELS,
  pressTokensForValue,
  ReportCadence,
  RolloverTracker,
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

console.log('diag-core: bootPressedUsages');
{
  const boot = decodeBootKeyboardReport(new Uint8Array([0x01, 0, 0x04, 0, 0, 0, 0, 0]))!;
  const s = bootPressedUsages(boot);
  check('modifiers + keys merged', eq([...s].sort((a, b) => a - b), [0x04, 0xe0]));
}

console.log('diag-core: RolloverTracker');
{
  const t = new RolloverTracker();
  t.down('KeyA');
  t.down('KeyB');
  t.down('KeyA'); // auto-repeat
  let s = t.snapshot();
  check('two distinct keys held', s.heldCount === 2 && s.peak === 2);
  check('repeat counted not pressed', s.presses === 2 && s.repeats === 1);
  check('held sorted', eq(s.held, ['KeyA', 'KeyB']));
  t.down('KeyC');
  t.down('KeyD');
  t.down('KeyE');
  t.down('KeyF');
  t.down('KeyG');
  t.down('KeyH');
  t.down('KeyI');
  s = t.snapshot();
  check('peak tracks simultaneous', s.peak === 9 && s.heldCount === 9);
  t.up('KeyA');
  t.up('KeyZ'); // orphan keyup
  s = t.snapshot();
  check('release matched', s.releases === 1 && s.orphanReleases === 1);
  check('held after release', s.heldCount === 8 && !s.held.includes('KeyA'));
  t.reset();
  s = t.snapshot();
  check('reset counts lost', s.lostReleases === 8 && s.heldCount === 0);
  check('peak survives reset', s.peak === 9);
}

console.log('diag-core: ChatterTracker');
{
  const t = new ChatterTracker();
  // 'A' (0x04) pressed at t=0, released at t=10 → 10 ms press.
  t.feed(new Set([0x04]), 0);
  t.feed(new Set(), 10);
  // Same key again: press at 100, release at 115 → 15 ms.
  t.feed(new Set([0x04]), 100);
  t.feed(new Set(), 115);
  // Long press: 200→900 = 700 ms.
  t.feed(new Set([0x04]), 200);
  t.feed(new Set(), 900);
  const a = t.all().find((u) => u.usage === 0x04);
  check('press/release counted', a?.presses === 3 && a?.releases === 3);
  check('min press duration', a?.minPressMs === 10);
  check('last press duration', a?.lastPressMs === 700);
  check('not yet a chatter suspect', a?.chatter === false);
  check('suspects empty', t.suspects().length === 0);

  // Fourth fast press → suspect (≥4 presses, min < 30 ms).
  t.feed(new Set([0x04]), 1000);
  t.feed(new Set(), 1010);
  const a2 = t.all().find((u) => u.usage === 0x04);
  check('4 fast presses → chatter flag', a2?.chatter === true);
  check('suspects lists it', t.suspects().some((u) => u.usage === 0x04));

  // Modifier usage transitions work identically.
  t.feed(new Set([0xe0]), 2000);
  t.feed(new Set(), 2050);
  const m = t.all().find((u) => u.usage === 0xe0);
  check('modifier timing tracked', m?.presses === 1 && m?.lastPressMs === 50);

  // Held key across feeds counts as one press, no release.
  const t2 = new ChatterTracker();
  t2.feed(new Set([0x05]), 0);
  t2.feed(new Set([0x05]), 16);
  t2.feed(new Set([0x05]), 32);
  const b = t2.all().find((u) => u.usage === 0x05);
  check('steady hold = 1 press', b?.presses === 1 && b?.releases === 0);
  check('held reports downAt', b?.downAt === 0);

  // Ordering: most transitions first.
  check('sorted by transitions', t.all()[0]!.usage === 0x04);
}

console.log('diag-core: ReportCadence');
{
  const c = new ReportCadence();
  check('no stats before 2 reports', c.stats() === null);
  c.push(1000);
  c.push(1016);
  c.push(1040);
  c.push(1100);
  const s = c.stats();
  check('cadence samples = reports-1', s?.samples === 3);
  check('cadence min', s?.minMs === 16);
  check('cadence avg', s?.avgMs === (16 + 24 + 60) / 3);
  check('cadence max', s?.maxMs === 60);
  c.reset();
  check('reset clears stats', c.stats() === null);
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall diag-core checks passed');
