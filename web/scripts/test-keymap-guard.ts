/**
 * Unit tests for `src/keymap-guard.ts` + the `keymapBase` guard path in
 * `src/state/keymap.ts` (bead oh-my-gravastar-keymap-base-guard-zb7).
 * Runs under Node's native TS stripping:
 *
 *   node scripts/test-keymap-guard.ts
 *
 * No DOM, no device: `guardKeymapBase`/`isOpaqueKeymapValue` are pure,
 * and `keymapBase` is exercised against the real `app` store with a
 * fake session injected into `app.connected`.
 */

declare const process: { exit(code?: number): never };

import { guardKeymapBase, isOpaqueKeymapValue } from '../src/keymap-guard.ts';
import { keymapBase } from '../src/state/keymap.ts';
import { app } from '../src/state/core.ts';
import type { KeyEntry } from '../src/state/core.ts';

let failures = 0;
function check(name: string, cond: unknown, extra = ''): void {
  if (cond) {
    console.log(`  ok  ${name}`);
  } else {
    failures++;
    console.error(`FAIL  ${name} ${extra}`);
  }
}
function checkThrows(name: string, fn: () => unknown, match?: RegExp): void {
  try {
    fn();
    failures++;
    console.error(`FAIL  ${name} — did not throw`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (match && !match.test(msg)) {
      failures++;
      console.error(`FAIL  ${name} — wrong message: ${msg}`);
    } else {
      console.log(`  ok  ${name}`);
    }
  }
}
async function checkThrowsAsync(name: string, fn: () => Promise<unknown>, match?: RegExp): Promise<void> {
  try {
    await fn();
    failures++;
    console.error(`FAIL  ${name} — did not throw`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (match && !match.test(msg)) {
      failures++;
      console.error(`FAIL  ${name} — wrong message: ${msg}`);
    } else {
      console.log(`  ok  ${name}`);
    }
  }
}
function section(title: string): void {
  console.log(`\n== ${title}`);
}

// A plausible K1 Pro table: 126 slots, mostly 'a' (0x04), one Fn switch,
// and the undocumented tag-0x08 Fn-layer values that must pass opaque.
const GOOD_TABLE: number[] = Array.from({ length: 126 }, (_, i) =>
  i === 4 ? 0x08020000 : i === 5 ? 0x000f0004 : 0x00000004,
);

section('guardKeymapBase — length guards');
checkThrows('empty base throws', () => guardKeymapBase([], { arg: 0 }), /empty/);
checkThrows(
  'short base vs expectedLen throws',
  () => guardKeymapBase(GOOD_TABLE.slice(0, 60), { arg: 0, expectedLen: 126 }),
  /60.*126|126.*60/,
);
checkThrows(
  'long base vs expectedLen throws',
  () => guardKeymapBase([...GOOD_TABLE, 0], { arg: 0, expectedLen: 126 }),
  /127.*126|126.*127/,
);
{
  const out = guardKeymapBase(GOOD_TABLE, { arg: 0, expectedLen: 126 });
  check('matching length passes', out.length === 126);
  check('returns a copy, not the input', out !== GOOD_TABLE);
}
{
  const out = guardKeymapBase(GOOD_TABLE, { arg: 0 }); // no reference
  check('non-empty base passes without expectedLen', out.length === 126);
}

section('guardKeymapBase — corrupt values');
for (const [name, bad] of [
  ['NaN', Number.NaN],
  ['negative', -1],
  ['fractional', 1.5],
  ['above u32', 0x1_0000_0000],
  ['Infinity', Number.POSITIVE_INFINITY],
] as const) {
  const table = GOOD_TABLE.slice();
  table[10] = bad;
  checkThrows(`slot with ${name} throws`, () => guardKeymapBase(table, { arg: 0 }), /slot 10|corrupt/);
}
{
  // Sparse hole reads as undefined — also corruption.
  const table = GOOD_TABLE.slice() as unknown[];
  table[10] = undefined;
  checkThrows('hole (undefined) slot throws', () => guardKeymapBase(table as number[], { arg: 0 }), /slot 10|corrupt/);
}
{
  const table = GOOD_TABLE.slice();
  table[10] = 0xffff_ffff; // max u32 — valid
  const out = guardKeymapBase(table, { arg: 0 });
  check('0xFFFFFFFF slot passes', out[10] === 0xffff_ffff);
}

section('guardKeymapBase — opaque tags pass verbatim (§Safety 7)');
{
  const table = GOOD_TABLE.slice();
  table[4] = 0x08020000; // tag 0x08 — undocumented Fn-layer value
  table[79] = 0x08030100;
  const out = guardKeymapBase(table, { arg: 1, expectedLen: 126 });
  check('tag-0x08 slots pass the guard', out[4] === 0x08020000 && out[79] === 0x08030100);
  check('opaque values preserved byte-identical', out[4] === table[4] && out[79] === table[79]);
}
{
  const out = guardKeymapBase([0xdeadbeef, 0x00000004, 0], { arg: 0 });
  check('arbitrary unknown high-byte tags pass', out[0] === 0xdeadbeef);
}

section('isOpaqueKeymapValue');
check('tag 0x08 is opaque', isOpaqueKeymapValue(0x08020000) === true);
check('arbitrary unknown tag is opaque', isOpaqueKeymapValue(0xdeadbeef) === true);
check('empty slot is not opaque', isOpaqueKeymapValue(0) === false);
check('normal key is not opaque', isOpaqueKeymapValue(0x00000004) === false);
check('Fn-layer switch (0x0d) is not opaque', isOpaqueKeymapValue(0x0d000001) === false);
check('macro tag (0x03) is not opaque', isOpaqueKeymapValue(0x03000102) === false);
check('SOCD tag (0x20) is not opaque', isOpaqueKeymapValue(0x20000001) === false);

// ── keymapBase against a mocked session ────────────────────────────────

function entriesOf(values: readonly number[]): KeyEntry[] {
  return values.map((value) => ({ value, kv: { kind: 'empty' }, label: '' }));
}

function mockSession(table: () => Promise<number[]>): void {
  // Minimal fake: keymapBase only calls session.keymap(arg).
  (app as { connected: unknown }).connected = {
    session: {
      keymap: async (_arg: number) => entriesOf(await table()),
    },
  };
  (app as { snapshot: unknown }).snapshot = { keymaps: new Map() };
}

section('keymapBase — mocked session');
{
  mockSession(async () => []);
  await checkThrowsAsync('empty device read aborts', () => keymapBase(0), /empty/);
}
{
  mockSession(async () => GOOD_TABLE.slice(0, 60)); // short read, no reference yet
  const out = await keymapBase(0);
  check('first short read passes (no cross-arg reference yet)', out.length === 60);

  // Now seed another arg at the "real" length and re-read arg 0 short.
  (app.snapshot?.keymaps as Map<number, KeyEntry[]>).set(1, entriesOf(GOOD_TABLE));
  (app.snapshot?.keymaps as Map<number, KeyEntry[]>).delete(0);
  await checkThrowsAsync(
    'short read vs cached sibling arg aborts',
    () => keymapBase(0),
    /60.*126|126.*60/,
  );
}
{
  mockSession(async () => GOOD_TABLE);
  const out = await keymapBase(1);
  check('full read passes and caches', out.length === 126 && out[4] === 0x08020000);
}
{
  // Corrupt slot through the session path.
  const bad = GOOD_TABLE.slice();
  bad[3] = -4;
  mockSession(async () => bad);
  await checkThrowsAsync('corrupt slot via session aborts', () => keymapBase(2), /slot 3|corrupt/);
}

// Restore shared state for any later tests in the same process.
(app as { connected: unknown }).connected = null;
(app as { snapshot: unknown }).snapshot = null;

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall keymap-guard checks passed');
