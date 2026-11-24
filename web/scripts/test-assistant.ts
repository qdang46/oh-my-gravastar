/**
 * Unit tests for `src/assistant-core.ts` — the DOM-free logic behind the
 * AI Assistant page (bead oh-my-gravastar-7js PART 2): OpInput → schema
 * op lowering, op descriptions, question chips and capability hints.
 * Runs under Node's native TS stripping:
 *
 *   node scripts/test-assistant.ts        (wired into `npm test`)
 *
 * Everything is synthetic: `K1_PRO_BLOCKS` stands in for the device
 * layout, hand-built `OpInput`s stand in for parser output. No device,
 * no DOM, no network.
 */

declare const process: { exit(code?: number): never };

import {
  describeOpInput,
  keyRefToIndex,
  keyRefToValue,
  lowerOpInputs,
  possibleFeatures,
  questionChips,
} from '../src/assistant-core.ts';
import { parseIntent, type OpInput } from '../src/agent/intent.ts';
import { K1_PRO_BLOCKS, keyIndexOf } from '../src/k1pro-layout.ts';
import { KEY_POOL } from '../src/keypool.ts';
import type { CapabilityMap } from '../src/core/capabilities.ts';

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

const LAYOUT = { layout: K1_PRO_BLOCKS };

function poolValue(name: string): number {
  const e = KEY_POOL.find((x) => x.name === name);
  if (!e) throw new Error(`no pool entry ${name}`);
  return e.value >>> 0;
}

function slotOf(blockName: string): number {
  const b = K1_PRO_BLOCKS.find((x) => x.name === blockName);
  if (!b) throw new Error(`no block ${blockName}`);
  return keyIndexOf(b.pos);
}

// ── keyRefToIndex / keyRefToValue ──────────────────────────────────────

section('keyRefToIndex / keyRefToValue');
check('caps_lock → Caps slot', keyRefToIndex('caps_lock', K1_PRO_BLOCKS) === slotOf('Caps'));
check('vendor name Caps → same slot', keyRefToIndex('Caps', K1_PRO_BLOCKS) === slotOf('Caps'));
check('letter w → W slot', keyRefToIndex('w', K1_PRO_BLOCKS) === slotOf('W'));
check('raw index passes through', keyRefToIndex(7, K1_PRO_BLOCKS) === 7);
check('unknown key → null', keyRefToIndex('not_a_key', K1_PRO_BLOCKS) === null);
check('no layout → null for names', keyRefToIndex('caps_lock', undefined) === null);
check('caps_lock → pool Caps value', keyRefToValue('caps_lock') === poolValue('Caps'));
check('mouse_left → pool value', keyRefToValue('mouse_left') === poolValue('mouse-left'));
check('number passes through', keyRefToValue(42) === 42);
check('unknown → null', keyRefToValue('bogus') === null);

// ── lowerOpInputs: set_keymap ───────────────────────────────────────────

section('lowerOpInputs set_keymap');
{
  const r = lowerOpInputs(
    [{ op: 'set_keymap', device_selector: 'auto', layer: 0, keys: { caps_lock: 'left_ctrl', w: 'arrow_up' } }],
    LAYOUT,
  );
  check('no problems', r.problems.length === 0, r.problems.join('|'));
  check('one op out', r.ops.length === 1);
  const op = r.ops[0] as { entries: { index: number; value: number }[]; layer: number };
  check('caps slot patched', op.entries.some((e) => e.index === slotOf('Caps') && e.value === poolValue('L_Ctrl')));
  check('w slot patched to Up', op.entries.some((e) => e.index === slotOf('W') && e.value === poolValue('Up')));
  check('layer preserved', op.layer === 0);
}
{
  const r = lowerOpInputs(
    [{ op: 'set_keymap', device_selector: 'auto', layer: 2, keys: { a: 'mouse_left' } }],
    LAYOUT,
  );
  check('mouse target lowers', r.problems.length === 0 && r.ops.length === 1);
  const op = r.ops[0] as { entries: { value: number }[]; layer: number };
  check('mouse-left value', op.entries[0]?.value === poolValue('mouse-left'));
  check('layer 2 preserved', op.layer === 2);
}
{
  const r = lowerOpInputs(
    [{ op: 'set_keymap', device_selector: 'auto', layer: 0, keys: { caps_lock: 'left_ctrl' } }],
    {},
  );
  check('no layout → problem, op dropped', r.ops.length === 0 && r.problems.length > 0);
}
{
  const r = lowerOpInputs(
    [{ op: 'set_keymap', device_selector: 'auto', layer: 0, keys: { bogus_key: 'left_ctrl' } }],
    LAYOUT,
  );
  check('unknown source → problem', r.ops.length === 0 && r.problems.some((p) => p.includes('bogus_key')));
}

// ── lowerOpInputs: set_adv ─────────────────────────────────────────────

section('lowerOpInputs set_adv');
{
  const r = lowerOpInputs(
    [{
      op: 'set_adv', device_selector: 'auto', mode: 'mt',
      key: 'caps_lock', tap: 'esc', hold: 'left_ctrl', hold_ms: 200,
    }],
    LAYOUT,
  );
  check('mt lowers clean', r.problems.length === 0, r.problems.join('|'));
  const op = r.ops[0] as { key?: number; tap?: number; hold?: number; hold_ms?: number; mode: string };
  check('mt key → Caps slot', op.key === slotOf('Caps'));
  check('mt tap → ESC u32', op.tap === poolValue('ESC'));
  check('mt hold → L_Ctrl u32', op.hold === poolValue('L_Ctrl'));
  check('mt hold_ms kept', op.hold_ms === 200);
}
{
  const r = lowerOpInputs(
    [{ op: 'set_adv', device_selector: 'auto', mode: 'socd', key_a: 'a', key_b: 'd' }],
    LAYOUT,
  );
  check('socd lowers', r.problems.length === 0);
  const op = r.ops[0] as { key_a?: number; key_b?: number };
  check('socd slots', op.key_a === slotOf('A') && op.key_b === slotOf('D'));
}

// ── lowerOpInputs: set_macro / restore / profile / light ───────────────

section('lowerOpInputs other ops');
{
  const r = lowerOpInputs(
    [{
      op: 'set_macro', device_selector: 'auto', name: 'hi',
      steps: [{ action: 'down', key: 'KeyH', delay_ms: 0 }],
      bind_key: 'q',
    }],
    LAYOUT,
  );
  check('macro lowers', r.problems.length === 0, r.problems.join('|'));
  const op = r.ops[0] as { bind_key?: number; name?: string };
  check('bind_key → Q slot', op.bind_key === slotOf('Q'));
  check('name kept', op.name === 'hi');
}
{
  const r = lowerOpInputs(
    [{ op: 'restore_snapshot', device_selector: 'auto', latest: true }],
    { snapshots: [
      { id: 'snap-old', label: 'old', ts: '2024-01-01T00:00:00Z' },
      { id: 'snap-new', label: 'new', ts: '2024-06-01T00:00:00Z' },
    ] },
  );
  check('latest → newest snapshot', r.problems.length === 0);
  check('id resolved', (r.ops[0] as { id: string }).id === 'snap-new');
}
{
  const r = lowerOpInputs(
    [{ op: 'restore_snapshot', device_selector: 'auto', latest: true }],
    { snapshots: [] },
  );
  check('no snapshots → problem', r.ops.length === 0 && r.problems.length > 0);
}
{
  const r = lowerOpInputs(
    [{ op: 'set_profile_section', device_selector: 'auto', section: 'sleep_seconds', value: 60 }],
    LAYOUT,
  );
  check('profile section passes through', r.ops.length === 1 && r.problems.length === 0);
}
{
  const r = lowerOpInputs(
    [{ op: 'set_light', device_selector: 'auto', config: { mode: 2, color: '#2244FF' } }],
    LAYOUT,
  );
  check('light config passes through', r.ops.length === 1 && r.problems.length === 0);
}

// ── End-to-end: parser output lowers cleanly ───────────────────────────

section('parseIntent → lowerOpInputs round-trip');
{
  const intent = parseIntent('caps lock thành ctrl', {
    deviceSelector: 'auto',
    layout: K1_PRO_BLOCKS,
  });
  check('parser emits one keymap op', intent.ops.length === 1 && intent.ops[0]!.op === 'set_keymap');
  const r = lowerOpInputs(intent.ops, LAYOUT);
  check('round-trip lowers clean', r.problems.length === 0 && r.ops.length === 1, r.problems.join('|'));
  const op = r.ops[0] as { entries: { index: number; value: number }[] };
  check('entry is Caps→L_Ctrl', op.entries[0]?.index === slotOf('Caps') && op.entries[0]?.value === poolValue('L_Ctrl'));
}
{
  const intent = parseIntent('caps mod-tap tap esc hold ctrl 200ms', {
    deviceSelector: 'auto',
    layout: K1_PRO_BLOCKS,
  });
  const adv = intent.ops.find((o) => o.op === 'set_adv');
  check('parser emits adv op', adv !== undefined, JSON.stringify(intent.questions));
  if (adv) {
    const r = lowerOpInputs([adv], LAYOUT);
    check('adv round-trip clean', r.problems.length === 0, r.problems.join('|'));
  }
}

// ── describeOpInput ────────────────────────────────────────────────────

section('describeOpInput');
{
  const d = describeOpInput({
    op: 'set_keymap', device_selector: 'auto', layer: 0,
    keys: { caps_lock: 'left_ctrl', w: 'arrow_up' },
  });
  check('keymap description', d.includes('layer 0') && d.includes('Caps') && d.includes('Ctrl'), d);
}
{
  const d = describeOpInput({ op: 'set_profile_section', device_selector: 'auto', section: 'sleep_seconds', value: 300 });
  check('sleep description', d.includes('300'), d);
}
{
  const d = describeOpInput({
    op: 'set_light', device_selector: 'auto',
    config: { mode: 2, color: '#FF0000', brightness: 10 },
  });
  check('light description has mode name', /breathing/i.test(d), d);
}
{
  const d = describeOpInput({ op: 'restore_snapshot', device_selector: 'auto', latest: true });
  check('restore latest description', d.includes('latest'), d);
}

// ── questionChips ──────────────────────────────────────────────────────

section('questionChips');
{
  const chips = questionChips('Which snapshot? Candidates: before-update, factory.', {
    snapshots: [
      { id: 's1', label: 'before-update', ts: '2024-01-01T00:00:00Z' },
      { id: 's2', label: 'factory', ts: '2024-01-02T00:00:00Z' },
    ],
  });
  check('snapshot chips from candidates', chips.length === 2 && chips[0]!.append === 'before-update', JSON.stringify(chips));
}
{
  const chips = questionChips('Which snapshot should be used?', {
    snapshots: [
      { id: 's1', label: 'morning', ts: '2024-01-01T00:00:00Z' },
      { id: 's2', label: 'evening', ts: '2024-01-02T00:00:00Z' },
    ],
  });
  check('snapshot chips from store', chips.length === 2 && chips[1]!.label.includes('evening'));
}
{
  const chips = questionChips('Which macro? Known: hi, bye.', { macros: [{ name: 'hi' }, { name: 'bye' }] });
  check('macro chips', chips.length === 2 && chips[0]!.append === 'hi');
}
{
  const chips = questionChips('"khi giữ Fn" needs a target layer — which layer should the Fn-held mapping live on (1–4)?');
  check('layer chips 1–4', chips.length === 4 && chips[0]!.append === 'layer 1' && chips[3]!.append === 'layer 4');
}
{
  const chips = questionChips('Something totally unknown?');
  check('no candidates → no chips', chips.length === 0);
}

// ── possibleFeatures ───────────────────────────────────────────────────

section('possibleFeatures');
const KHUB916_CAPS: CapabilityMap = {
  keymap: { state: 'supported', verified: 'live', layers: 4 },
  layers: { state: 'supported', verified: 'live', layers: 4 },
  macro: { state: 'supported', verified: 'live' },
  per_key_rgb: { state: 'supported', verified: 'live' },
  lighting_effects: { state: 'supported', verified: 'live' },
  adv_keys: { state: 'unverified', verified: 'code', reason: 'unconfirmed' },
  rapid_trigger: { state: 'unsupported-hardware', verified: 'none', reason: 'mechanical' },
};
{
  const f = possibleFeatures(KHUB916_CAPS);
  check('lists supported features', f.includes('Keymap editor') && f.includes('Macro studio') && f.includes('Lighting studio'), f.join('|'));
  check('unverified adv keys still listed', f.includes('Advanced keys (SOCD/MT/TGL)'));
  check('unsupported excluded', !f.some((x) => /rapid|actuation|deadzone/i.test(x)));
}
check('no caps → empty', possibleFeatures(undefined).length === 0);

// ── Summary ────────────────────────────────────────────────────────────

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} FAILURES`}`);
process.exit(failures === 0 ? 0 : 1);
