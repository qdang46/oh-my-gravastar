/**
 * Unit tests for the opaque-slot / system-arg locks added for bead
 * oh-my-gravastar-remap-opaque-slots-nw5:
 *
 * - `opaqueKeymapSlots` / `isOpaqueKeymapValue` — tag-0x08 Fn-layer
 *   firmware values must be recognised as opaque (§Safety 7);
 * - `keymapReadError` — the display-time whole-arg lock: a cached read
 *   that fails the keymap-base guard yields a reason, a good read null;
 * - the system-arg decision — args 4–7 (`arg & 4`) are locked because
 *   their cmd-131 reads come back garbled on the K1 Pro.
 *
 * Runs under Node's native TS stripping:
 *
 *   node scripts/test-keymap-opaque.ts
 *
 * No DOM, no device — everything under test is pure.
 */

declare const process: { exit(code?: number): never };

import {
  SYSTEM_ARG_LOCK_REASON,
  SYSTEM_KEYMAP_ARGS_TRUSTED,
  isOpaqueKeymapValue,
  isSystemKeymapArg,
  keymapReadError,
  opaqueKeymapSlots,
} from '../src/keymap-guard.ts';

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

// A plausible K1 Pro Fn layer (arg 1): mostly 'a' (0x04), Fn switch on
// slot 59, and the undocumented tag-0x08 firmware action values.
const FN_LAYER: number[] = Array.from({ length: 126 }, (_, i) =>
  i === 59 ? 0x0d000000 : i === 80 ? 0x08000000 : i === 88 ? 0x08030100 : 0x00000004,
);

section('isOpaqueKeymapValue — opaque vs editable');
check('tag 0x08 is opaque', isOpaqueKeymapValue(0x08030200) === true);
check('tag 0x08 variant is opaque', isOpaqueKeymapValue(0x08040100) === true);
check('empty slot is not opaque', isOpaqueKeymapValue(0) === false);
check('normal key is not opaque', isOpaqueKeymapValue(0x00000004) === false);
check('Fn switch (0x0d) is not opaque', isOpaqueKeymapValue(0x0d000000) === false);
check('macro (0x03) is not opaque', isOpaqueKeymapValue(0x03000102) === false);
check('secondary (0x07) is not opaque', isOpaqueKeymapValue(0x0700001d) === false);
check('SOCD (0x20) is not opaque', isOpaqueKeymapValue(0x20000001) === false);

section('opaqueKeymapSlots');
{
  const slots = opaqueKeymapSlots(FN_LAYER);
  check('Fn layer reports exactly the tag-8 slots', slots.length === 2, `got ${slots}`);
  check('opaque indices are 80 and 88', slots[0] === 80 && slots[1] === 88, `got ${slots}`);
}
{
  const clean = Array.from({ length: 126 }, () => 0x00000004);
  check('clean table has no opaque slots', opaqueKeymapSlots(clean).length === 0);
}
{
  check('empty table has no opaque slots', opaqueKeymapSlots([]).length === 0);
}

section('keymapReadError — display-time whole-arg lock');
{
  const err = keymapReadError(0, FN_LAYER, [126]);
  check('good read returns null', err === null, String(err));
}
{
  const err = keymapReadError(1, [], [126]);
  check('empty read locks', typeof err === 'string' && /empty/.test(err), String(err));
}
{
  const err = keymapReadError(0, FN_LAYER.slice(0, 60), [126]);
  check('short read vs sibling length locks', typeof err === 'string' && /60.*126|126.*60/.test(err), String(err));
}
{
  const bad = FN_LAYER.slice();
  bad[10] = -1;
  const err = keymapReadError(0, bad, [126]);
  check('corrupt slot locks', typeof err === 'string' && /slot 10|corrupt/.test(err), String(err));
}
{
  // First read of a session: no sibling reference — only non-empty +
  // well-formed values are required (same rule as keymapBase).
  const err = keymapReadError(0, FN_LAYER.slice(0, 60), []);
  check('short read passes without sibling reference', err === null, String(err));
}
{
  const err = keymapReadError(4, FN_LAYER, [126]);
  check('guard itself does not special-case system args', err === null, String(err));
}

section('system-arg decision (args 4–7)');
check('isSystemKeymapArg flags args 4–7', [4, 5, 6, 7].every(isSystemKeymapArg));
check('isSystemKeymapArg clears args 0–3', [0, 1, 2, 3].every((a) => !isSystemKeymapArg(a)));
check(
  'system args are locked pending a understood read shape',
  SYSTEM_KEYMAP_ARGS_TRUSTED === false,
);
check('lock reason is a non-empty explanation', SYSTEM_ARG_LOCK_REASON.length > 20);

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall keymap-opaque checks passed');
