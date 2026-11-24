/**
 * Unit tests for `src/fn-doctor-core.ts` — the DOM-free Fn-layer
 * diagnostic (bead oh-my-gravastar-fn-layer-doctor-yw0, web half).
 * Runs under Node's native TS stripping:
 *
 *   node scripts/test-fn-doctor.ts
 *
 * Fixture keymap tables only — no DOM, no device, no session.
 */

declare const process: { exit(code?: number): never };

import {
  analyzeFnLayer,
  BASE_LAYER_ARG,
  FN_LAYER_ARG,
  type FnDoctorReport,
} from '../src/fn-doctor-core.ts';

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

// ── Fixtures ──────────────────────────────────────────────────────────
// A small "keyboard": slots 0..3 are physical keys A/B/C/D, slot 4 is a
// non-physical aux slot, slot 5 is the Fn key.
const PHYSICAL = new Map<number, string>([
  [0, 'A'],
  [1, 'B'],
  [2, 'C'],
  [3, 'D'],
  [5, 'Fn'],
]);
const FN_INDEX = 5;

/** Fn layer: every physical slot carries a normal key value. */
function intactFnLayer(): number[] {
  return [0x00000004, 0x00000005, 0x00000006, 0x00000007, 0, 0x03000102];
}
/** Base layer: slot 5 holds the Fn-layer switch 0x0D000000. */
function intactBase(): number[] {
  return [0x00000004, 0x00000005, 0x00000006, 0x00000007, 0, 0x0d000000];
}

function analyze(
  fn: number[],
  base: number[],
  physical: Map<number, string> | null = PHYSICAL,
  fnKeyIndex: number | null = FN_INDEX,
): FnDoctorReport {
  return analyzeFnLayer(fn, base, {
    physical,
    fnKeyIndex,
    fnKeyName: fnKeyIndex === null ? null : 'Fn',
  });
}

section('intact Fn layer');
{
  const r = analyze(intactFnLayer(), intactBase());
  check('verdict is intact', r.intact === true, r.summary);
  check('summary is the intact line', r.summary === 'Fn layer intact', r.summary);
  check('no dead slots', r.dead.length === 0);
  check('fn key status fn', r.fnKey.status === 'fn');
  check('fn key base value', r.fnKey.baseValue === 0x0d000000);
  check('args are the documented ones', r.fnArg === FN_LAYER_ARG && r.baseArg === BASE_LAYER_ARG);
  check('slot count from fn read', r.slotCount === 6);
}

section('dead slots (value 0x00000000 on the Fn layer)');
{
  const fn = intactFnLayer();
  fn[0] = 0; // 'A' loses its Fn action
  fn[2] = 0; // 'C' too
  const r = analyze(fn, intactBase());
  check('not intact', r.intact === false);
  check('two dead slots', r.dead.length === 2);
  check('dead slots named from layout', r.dead[0]?.name === 'A' && r.dead[1]?.name === 'C');
  check('dead slot indices', r.dead[0]?.index === 0 && r.dead[1]?.index === 2);
  check(
    'summary lists the names',
    r.summary.includes('2 keys have no Fn action') &&
      r.summary.includes('A') &&
      r.summary.includes('C'),
    r.summary,
  );
}
{
  // Slot 4 is NOT in the physical map — its zero is not a "dead key".
  const r = analyze(intactFnLayer(), intactBase());
  check('non-physical zero slot ignored', !r.dead.some((s) => s.index === 4));
}

section('opaque / unknown-tag slots');
{
  const fn = intactFnLayer();
  fn[1] = 0x08020000; // undocumented tag-0x08 Fn action
  fn[3] = 0xdeadbeef; // arbitrary unknown tag
  const r = analyze(fn, intactBase());
  check('two opaque slots flagged', r.opaque.length === 2, r.summary);
  check('opaque names resolved', r.opaque[0]?.name === 'B' && r.opaque[1]?.name === 'D');
  check('opaque values kept raw', r.opaque[0]?.value === 0x08020000);
  check('opaque alone does not break intact', r.intact === true, r.summary);
  check('summary mentions opaque count', r.summary.includes('2 slots carry opaque'), r.summary);
}

section('Fn key cross-check in the base layer');
{
  // Fn key reads 0 — the key has no binding at all.
  const base = intactBase();
  base[5] = 0;
  const r = analyze(intactFnLayer(), base);
  check('empty fn key → not intact', r.intact === false);
  check('status empty', r.fnKey.status === 'empty');
  check('summary explains the Fn key', r.summary.includes('no binding'), r.summary);
}
{
  // Fn key rebound to a plain key — Fn+X legitimately does nothing.
  const base = intactBase();
  base[5] = 0x00000007; // 'D'
  const r = analyze(intactFnLayer(), base);
  check('rebound fn key → not intact', r.intact === false);
  check('status rebound', r.fnKey.status === 'rebound');
  check('rebound label is the new action', r.fnKey.label === 'D', String(r.fnKey.label));
  check('summary says it no longer switches', r.summary.includes('no longer switches'), r.summary);
}
{
  // Fn key bound to a different layer switch still counts as fn.
  const base = intactBase();
  base[5] = 0x0d000002; // Fn2
  const r = analyze(intactFnLayer(), base);
  check('Fn2 binding still counts as fn', r.fnKey.status === 'fn' && r.intact);
}
{
  // Base read too short to contain the slot.
  const r = analyze(intactFnLayer(), intactBase().slice(0, 3));
  check('short base → unreadable', r.fnKey.status === 'unreadable');
  check('unreadable does not break intact', r.intact === true, r.summary);
  check('summary notes the skipped check', r.summary.includes('could not be checked'), r.summary);
}

section('no layout table (physical = null, fnKeyIndex = null)');
{
  const fn = [0, 0x00000005, 0, 0x00000007, 0, 0x03000102];
  const r = analyze(fn, intactBase(), null, null);
  check('every zero slot is a candidate', r.dead.length === 3, r.summary);
  check('names fall back to slot n', r.dead[0]?.name === 'slot 0');
  check('fn key status no-layout', r.fnKey.status === 'no-layout');
  check('no-layout does not break intact by itself', r.intact === false); // dead slots do
  const clean = analyze([1, 2, 3, 4, 5, 6], intactBase(), null, null);
  check(
    'clean table without layout keeps the intact verdict',
    clean.intact === true && clean.summary.startsWith('Fn layer intact'),
    clean.summary,
  );
}

section('fnDoctorSummary edge cases');
{
  // >12 dead names get truncated in the one-liner.
  const physical = new Map<number, string>();
  const fn: number[] = [];
  for (let i = 0; i < 20; i++) {
    physical.set(i, `K${i}`);
    fn.push(0);
  }
  const r = analyze(fn, [], physical, null);
  check('long dead list truncated', r.summary.includes('+8 more'), r.summary);
  check('dead count still exact', r.dead.length === 20);
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall fn-doctor checks passed');
