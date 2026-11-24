/**
 * Unit tests for `src/agent/intent.ts` — the NL→ops parser
 * (bead oh-my-gravastar-7js PART 1). Runs under Node's native TS
 * stripping:
 *
 *   node scripts/test-intent.ts
 *
 * Everything is synthetic: hand-built capability maps stand in for
 * `DeviceContext.capabilities`, `K1_PRO_BLOCKS` stands in for the layout.
 * No device, no DOM, no network.
 */

declare const process: { exit(code?: number): never };

import {
  canonicalKey,
  extractKeys,
  foldIntent,
  parseIntent,
  type IntentContext,
  type OpInput,
} from '../src/agent/intent.ts';
import { K1_PRO_BLOCKS } from '../src/k1pro-layout.ts';
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

// ── Fixtures ───────────────────────────────────────────────────────────

/** khub916-like caps: keymap/macro/lighting live, adv unverified, HE-only off. */
const KHUB916_CAPS: CapabilityMap = {
  keymap: { state: 'supported', verified: 'live', layers: 4 },
  layers: { state: 'supported', verified: 'live', layers: 4 },
  macro: { state: 'supported', verified: 'live' },
  per_key_rgb: { state: 'supported', verified: 'live' },
  lighting_effects: { state: 'supported', verified: 'live' },
  adv_keys: {
    state: 'unverified',
    verified: 'code',
    reason: 'cmd-18 history persistence unconfirmed on K1 Pro',
  },
  rapid_trigger: {
    state: 'unsupported-hardware',
    verified: 'none',
    reason: 'mechanical-switch keyboard — no per-key analog travel sensing',
  },
};

const MOUSE_CAPS: CapabilityMap = {
  keymap: { state: 'unsupported-hardware', verified: 'none', reason: 'Compx mouse — not a keyboard' },
  layers: { state: 'unsupported-hardware', verified: 'none', reason: 'Compx mouse — not a keyboard' },
  macro: { state: 'unsupported-hardware', verified: 'none', reason: 'Compx mouse — not a keyboard' },
  per_key_rgb: { state: 'unsupported-hardware', verified: 'none', reason: 'Compx mouse — not a keyboard' },
  lighting_effects: { state: 'unsupported-hardware', verified: 'none', reason: 'Compx mouse — not a keyboard' },
  adv_keys: { state: 'unsupported-hardware', verified: 'none', reason: 'Compx mouse — not a keyboard' },
};

/** HE-v2-like caps: everything "supported" in code, no live device. */
const HE_CAPS: CapabilityMap = {
  keymap: { state: 'supported', verified: 'code' },
  rapid_trigger: { state: 'supported', verified: 'code' },
  actuation: { state: 'supported', verified: 'code' },
  polling: { state: 'supported', verified: 'code' },
};

const K1_CTX: IntentContext = {
  deviceSelector: 'auto',
  capabilities: KHUB916_CAPS,
  layout: K1_PRO_BLOCKS,
};

function opsOf(r: ReturnType<typeof parseIntent>): OpInput[] {
  return r.ops;
}
function keymapOp(r: ReturnType<typeof parseIntent>): Extract<OpInput, { op: 'set_keymap' }> | null {
  const o = r.ops.find((x) => x.op === 'set_keymap');
  return (o as Extract<OpInput, { op: 'set_keymap' }> | undefined) ?? null;
}
function lightOp(r: ReturnType<typeof parseIntent>): Extract<OpInput, { op: 'set_light' }> | null {
  const o = r.ops.find((x) => x.op === 'set_light');
  return (o as Extract<OpInput, { op: 'set_light' }> | undefined) ?? null;
}

// ── Normalisation ──────────────────────────────────────────────────────

section('foldIntent / canonicalKey / extractKeys');
check('fold strips Vietnamese diacritics', foldIntent('Đèn chỉ sáng WASD') === 'den chi sang wasd');
check('fold keeps ascii', foldIntent('Caps Lock') === 'caps lock');
check('canonicalKey caps lock', canonicalKey('Caps Lock') === 'caps_lock');
check('canonicalKey ctrl', canonicalKey('CTRL') === 'left_ctrl');
check('canonicalKey f5', canonicalKey('F5') === 'f5');
check('canonicalKey f13 rejected', canonicalKey('F13') === null);
check('canonicalKey gibberish', canonicalKey('frobnicate') === null);
{
  const { keys } = extractKeys('caps lock and W A S D');
  check('extractKeys finds caps+wasd', keys.includes('caps_lock') && ['w', 'a', 's', 'd'].every((k) => keys.includes(k)), keys.join(','));
}

// ── Empty / unknown ────────────────────────────────────────────────────

section('empty + unknown input');
{
  const r = parseIntent('');
  check('empty → question', r.questions.length > 0 && r.ops.length === 0);
}
{
  const r = parseIntent('xyzzy plugh frobnicate');
  check('gibberish → question, no ops', r.ops.length === 0 && r.questions.length > 0);
}
{
  const r = parseIntent('   ');
  check('whitespace → question', r.questions.length > 0);
}

// ── Keymap remaps ──────────────────────────────────────────────────────

section('set_keymap intents');
{
  const r = parseIntent('caps lock thành ctrl', K1_CTX);
  const op = keymapOp(r);
  check('caps→ctrl produces set_keymap', op !== null);
  check('caps→ctrl layer 0', op?.layer === 0);
  check('caps→ctrl mapping', op?.keys.caps_lock === 'left_ctrl', JSON.stringify(op?.keys));
  check('selector echoed', op?.device_selector === 'auto');
  check('understood notes base layer', r.understood.some((u) => u.includes('layer 0')), r.understood.join('|'));
}
{
  const r = parseIntent('Caps Lock as Left Ctrl', K1_CTX);
  check('English "as" remap', keymapOp(r)?.keys.caps_lock === 'left_ctrl');
}
{
  const r = parseIntent('đổi tab thành esc', K1_CTX);
  check('VN "đổi … thành" remap', keymapOp(r)?.keys.tab === 'esc');
}
{
  const r = parseIntent('caps lock -> delete', K1_CTX);
  check('"->" connector', keymapOp(r)?.keys.caps_lock === 'delete');
}
{
  const r = parseIntent('WASD thành arrow', K1_CTX);
  const op = keymapOp(r);
  check('WASD→arrow op', op !== null);
  check('W→up', op?.keys.w === 'arrow_up');
  check('A→left', op?.keys.a === 'arrow_left');
  check('S→down', op?.keys.s === 'arrow_down');
  check('D→right', op?.keys.d === 'arrow_right');
}
{
  const r = parseIntent('WASD thành arrow keys', K1_CTX);
  check('"arrow keys" also expands', keymapOp(r)?.keys.w === 'arrow_up');
}
{
  const r = parseIntent('WASD thành arrow khi giữ Fn', K1_CTX);
  check('Fn-held WASD→arrow: no op (ambiguous layer)', r.ops.length === 0);
  check('Fn-held WASD→arrow: question asks layer', r.questions.some((q) => /layer/i.test(q)), r.questions.join('|'));
  check('Fn-held WASD→arrow: understood notes Fn', r.understood.some((u) => /Fn-held/i.test(u)));
}
{
  const r = parseIntent('caps lock thành ctrl ở layer 2', K1_CTX);
  const op = keymapOp(r);
  check('explicit layer 2 → index 1', op?.layer === 1, `layer=${op?.layer}`);
}
{
  const r = parseIntent('caps lock thành ctrl trên tầng 3', K1_CTX);
  check('VN "tầng 3" → index 2', keymapOp(r)?.layer === 2);
}
{
  const r = parseIntent('frobnicate thành ctrl', K1_CTX);
  check('unknown source → question, no op', r.ops.length === 0 && r.questions.length > 0);
}
{
  const r = parseIntent('caps lock thành frobnicate', K1_CTX);
  check('unknown target → question, no op', r.ops.length === 0 && r.questions.length > 0);
}
{
  // "insert" is not a physical key on the K1 Pro layout.
  const r = parseIntent('insert thành ctrl', K1_CTX);
  check('non-layout source → question with layout', r.ops.length === 0 && r.questions.some((q) => /layout/i.test(q)), r.questions.join('|'));
}
{
  const r = parseIntent('caps lock thành ctrl', { capabilities: KHUB916_CAPS }); // no layout
  check('no layout still emits op (planner resolves)', keymapOp(r)?.keys.caps_lock === 'left_ctrl');
}
{
  const r = parseIntent('a thành b và c thành d', K1_CTX);
  // single-connector parse sees one pair; document behaviour: it should not crash
  check('multi-pair text handled without crash', r.ops.length + r.questions.length > 0);
}

// ── Lighting intents ───────────────────────────────────────────────────

section('set_light intents');
{
  const r = parseIntent('đèn đỏ', K1_CTX);
  const op = lightOp(r);
  check('"đèn đỏ" → set_light', op !== null);
  check('red colour', (op?.config.color as string) === '#FF0000', JSON.stringify(op?.config));
  check('plain colour → always_on', op?.config.mode === 1);
}
{
  const r = parseIntent('lighting red', K1_CTX);
  check('English "lighting red"', (lightOp(r)?.config.color as string) === '#FF0000');
}
{
  const r = parseIntent('đèn xanh lá', K1_CTX);
  check('"xanh lá" → green', (lightOp(r)?.config.color as string) === '#00FF00');
}
{
  const r = parseIntent('đèn xanh dương', K1_CTX);
  check('"xanh dương" → blue', (lightOp(r)?.config.color as string) === '#0000FF');
}
{
  const r = parseIntent('#FF0000 lighting', K1_CTX);
  check('hex colour', (lightOp(r)?.config.color as string) === '#FF0000');
}
{
  const r = parseIntent('turn off the lights', K1_CTX);
  check('"turn off lights" → mode 0', lightOp(r)?.config.mode === 0);
}
{
  const r = parseIntent('đèn tắt', K1_CTX);
  check('"đèn tắt" → mode 0', lightOp(r)?.config.mode === 0);
}
{
  const r = parseIntent('đèn thở', K1_CTX);
  check('"đèn thở" → breathing mode 2', lightOp(r)?.config.mode === 2);
}
{
  const r = parseIntent('breathing light please', K1_CTX);
  check('English breathing → mode 2', lightOp(r)?.config.mode === 2);
}
{
  const r = parseIntent('rainbow lighting', K1_CTX);
  check('rainbow → dream_rainbow mode 3', lightOp(r)?.config.mode === 3);
}
{
  const r = parseIntent('đèn wave', K1_CTX);
  check('wave → mode 11', lightOp(r)?.config.mode === 11);
}
{
  const r = parseIntent('đèn sáng 80%', K1_CTX);
  const op = lightOp(r);
  check('80% → brightness 16/20', op?.config.brightness === 16, JSON.stringify(op?.config));
}
{
  const r = parseIntent('den dim hon', K1_CTX);
  check('"dim" → brightness 5', lightOp(r)?.config.brightness === 5);
}
{
  const r = parseIntent('đèn chỉ sáng WASD', K1_CTX);
  const op = lightOp(r);
  check('"chỉ sáng WASD" → set_light', op !== null);
  check('per-key mode 277', op?.config.mode === 277);
  const keys = (op?.config.keys as { colors: string[] }).colors;
  check('126 colour slots', keys.length === 126);
  const lit = keys.filter((c) => c !== '#000000');
  check('exactly 4 keys lit', lit.length === 4, `lit=${lit.length}`);
  check('lit colour defaults white', lit.every((c) => c === '#FFFFFF'));
}
{
  const r = parseIntent('đèn chỉ sáng WASD màu đỏ', K1_CTX);
  const op = lightOp(r);
  const keys = (op?.config.keys as { colors: string[] }).colors;
  const lit = keys.filter((c) => c !== '#000000');
  check('"chỉ sáng WASD đỏ" → red lit keys', lit.length === 4 && lit.every((c) => c === '#FF0000'), lit.join(','));
}
{
  const r = parseIntent('đèn chỉ sáng WASD', { capabilities: KHUB916_CAPS }); // no layout
  check('per-key without layout → question, no op', r.ops.length === 0 && r.questions.length > 0);
}
{
  const r = parseIntent('lighting', K1_CTX);
  check('bare "lighting" → vague question', r.ops.length === 0 && r.questions.length > 0);
}

// ── Restore snapshot ───────────────────────────────────────────────────

section('restore_snapshot intents');
const SNAPS = [
  { id: 'snap-aaa', label: 'before gaming', ts: '2026-11-20T10:00:00Z' },
  { id: 'snap-bbb', label: 'after update', ts: '2026-11-24T10:00:00Z' },
];
{
  const r = parseIntent('khôi phục snapshot', { capabilities: KHUB916_CAPS, snapshots: [] });
  const op = r.ops.find((o) => o.op === 'restore_snapshot') as Extract<OpInput, { op: 'restore_snapshot' }> | undefined;
  check('restore with no snapshots → latest:true', op?.latest === true);
  check('restore with no snapshots → question', r.questions.length > 0);
}
{
  const r = parseIntent('khôi phục snapshot before gaming', { capabilities: KHUB916_CAPS, snapshots: SNAPS });
  const op = r.ops.find((o) => o.op === 'restore_snapshot') as Extract<OpInput, { op: 'restore_snapshot' }> | undefined;
  check('named snapshot → id resolved', op?.id === 'snap-aaa', JSON.stringify(op));
}
{
  const r = parseIntent('restore latest snapshot', { capabilities: KHUB916_CAPS, snapshots: SNAPS });
  const op = r.ops.find((o) => o.op === 'restore_snapshot') as Extract<OpInput, { op: 'restore_snapshot' }> | undefined;
  check('"latest" → newest ts', op?.id === 'snap-bbb');
}
{
  const r = parseIntent('khôi phục snapshot', { capabilities: KHUB916_CAPS, snapshots: SNAPS });
  check('unnamed snapshot → question, no op', r.ops.length === 0 && r.questions.length > 0);
}
{
  const amb = [
    { id: 'snap-1', label: 'gaming red', ts: '2026-11-20T10:00:00Z' },
    { id: 'snap-2', label: 'gaming blue', ts: '2026-11-21T10:00:00Z' },
  ];
  const r = parseIntent('khôi phục snapshot gaming', { capabilities: KHUB916_CAPS, snapshots: amb });
  check('ambiguous snapshot → question', r.ops.length === 0 && r.questions.length > 0);
}
{
  const r = parseIntent('factory reset', K1_CTX);
  check('factory reset → unsupported, no op', r.ops.length === 0 && r.unsupported.length > 0);
  check('factory reset mentions L4/forbidden', r.unsupported.some((u) => /L4|forbidden/i.test(u)));
}
{
  const r = parseIntent('reset máy về mặc định', K1_CTX);
  check('VN factory reset → unsupported', r.ops.length === 0 && r.unsupported.length > 0);
}

// ── Macro intents ──────────────────────────────────────────────────────

section('set_macro intents');
{
  const r = parseIntent('macro ghi hello', K1_CTX);
  const op = r.ops.find((o) => o.op === 'set_macro') as Extract<OpInput, { op: 'set_macro' }> | undefined;
  check('"macro ghi hello" → set_macro', op !== undefined);
  check('macro named after text', op?.name === 'hello');
  const steps = op?.steps as { action: string; key: string; delay_ms: number }[];
  check('hello → 10 steps (5 keys × down/up)', steps.length === 10, `steps=${steps?.length}`);
  check('first step KeyH down', steps[0]?.key === 'KeyH' && steps[0]?.action === 'down');
  check('second step KeyH up', steps[1]?.action === 'up');
}
{
  const r = parseIntent('tao macro tên chào', K1_CTX);
  check('named macro without keys → question', r.ops.length === 0 && r.questions.length > 0);
}
{
  const r = parseIntent('xóa macro hello', { ...K1_CTX, macros: [{ name: 'hello' }, { name: 'other' }] });
  const op = r.ops.find((o) => o.op === 'set_macro') as Extract<OpInput, { op: 'set_macro' }> | undefined;
  check('"xóa macro hello" → delete:true', op?.delete === true);
  check('delete targets "hello"', op?.name === 'hello');
}
{
  const r = parseIntent('delete macro', { ...K1_CTX, macros: [{ name: 'a' }, { name: 'b' }] });
  check('delete without name + many macros → question', r.ops.length === 0 && r.questions.length > 0);
}
{
  const r = parseIntent('macro ghi hi', MOUSE_CAPS ? { capabilities: MOUSE_CAPS, layout: K1_PRO_BLOCKS } : K1_CTX);
  check('macro on mouse → unsupported', r.ops.length === 0 && r.unsupported.length > 0);
}

// ── Advanced keys ──────────────────────────────────────────────────────

section('set_adv intents + capability gating');
{
  const r = parseIntent('socd a d', K1_CTX);
  const op = r.ops.find((o) => o.op === 'set_adv') as Extract<OpInput, { op: 'set_adv' }> | undefined;
  check('"socd a d" → set_adv socd', op?.mode === 'socd');
  check('socd keys a/d', op?.key_a === 'a' && op?.key_b === 'd');
  check('adv unverified caveat noted', r.understood.some((u) => /unverified/i.test(u)), r.understood.join('|'));
}
{
  const r = parseIntent('caps mod-tap tap esc hold ctrl 200ms', K1_CTX);
  const op = r.ops.find((o) => o.op === 'set_adv') as Extract<OpInput, { op: 'set_adv' }> | undefined;
  check('mod-tap → set_adv mt', op?.mode === 'mt');
  check('mt bind key caps_lock', op?.key === 'caps_lock');
  check('mt tap esc', op?.tap === 'esc');
  check('mt hold left_ctrl', op?.hold === 'left_ctrl');
  check('mt hold_ms 200', op?.hold_ms === 200);
}
{
  const r = parseIntent('tgl a b', K1_CTX);
  const op = r.ops.find((o) => o.op === 'set_adv') as Extract<OpInput, { op: 'set_adv' }> | undefined;
  check('"tgl a b" → set_adv tgl', op?.mode === 'tgl' && op?.key === 'a' && op?.toggle === 'b');
}
{
  const r = parseIntent('socd a', K1_CTX);
  check('SOCD one key → question', r.ops.length === 0 && r.questions.length > 0);
}
{
  const r = parseIntent('rapid trigger', K1_CTX);
  check('rapid trigger on khub916 → unsupported', r.ops.length === 0 && r.unsupported.some((u) => /rapid trigger/i.test(u)), r.unsupported.join('|'));
  check('rapid trigger cites mechanical reason', r.unsupported.some((u) => /mechanical/i.test(u)));
}
{
  const r = parseIntent('rapid trigger 8ms', { capabilities: HE_CAPS });
  check('rapid trigger on HE → still unsupported (no op in schema v1)', r.ops.length === 0 && r.unsupported.length > 0);
}
{
  const r = parseIntent('actuation 0.1mm', { capabilities: HE_CAPS });
  check('actuation on HE → unsupported no-op', r.unsupported.length > 0);
}
{
  const r = parseIntent('polling 8000', K1_CTX);
  check('polling → unsupported (no schema op)', r.unsupported.length > 0);
}
{
  const r = parseIntent('socd a d', { capabilities: MOUSE_CAPS });
  check('SOCD on mouse → unsupported', r.ops.length === 0 && r.unsupported.length > 0);
}

// ── Profile section ────────────────────────────────────────────────────

section('set_profile_section intents');
{
  const r = parseIntent('ngủ sau 2 phút', K1_CTX);
  const op = r.ops.find((o) => o.op === 'set_profile_section') as Extract<OpInput, { op: 'set_profile_section' }> | undefined;
  check('"ngủ 2 phút" → sleep_seconds 120', op?.section === 'sleep_seconds' && op?.value === 120, JSON.stringify(op));
}
{
  const r = parseIntent('sleep 200', K1_CTX);
  const op = r.ops.find((o) => o.op === 'set_profile_section') as Extract<OpInput, { op: 'set_profile_section' }> | undefined;
  check('"sleep 200" → 200', op?.value === 200);
}
{
  const r = parseIntent('sleep 300', K1_CTX);
  check('"sleep 300" → question (300s > u8 cap)', r.ops.length === 0 && r.questions.length > 0);
}
{
  const r = parseIntent('sleep 3000', K1_CTX);
  check('sleep >255 → question (u8 cap)', r.ops.length === 0 && r.questions.length > 0);
}
{
  const r = parseIntent('sleep off', K1_CTX);
  const op = r.ops.find((o) => o.op === 'set_profile_section') as Extract<OpInput, { op: 'set_profile_section' }> | undefined;
  check('"sleep off" → 0', op?.value === 0);
}
{
  const r = parseIntent('ngủ', K1_CTX);
  check('bare "ngủ" → question', r.ops.length === 0 && r.questions.length > 0);
}

// ── Explain / read-only ────────────────────────────────────────────────

section('read-only asks');
{
  const r = parseIntent('explain my keyboard', K1_CTX);
  check('explain → understood note, no ops', r.ops.length === 0 && r.understood.length > 0);
}
{
  const r = parseIntent('pin battery còn bao nhiêu', K1_CTX);
  check('battery ask → understood, no ops', r.ops.length === 0 && r.understood.length > 0);
}

// ── Capability gating on keymap/lighting ───────────────────────────────

section('capability gates');
{
  const r = parseIntent('caps lock thành ctrl', { capabilities: MOUSE_CAPS, layout: K1_PRO_BLOCKS });
  check('keymap on mouse → unsupported', r.ops.length === 0 && r.unsupported.length > 0);
}
{
  const r = parseIntent('đèn đỏ', { capabilities: MOUSE_CAPS, layout: K1_PRO_BLOCKS });
  check('lighting on mouse → unsupported', r.ops.length === 0 && r.unsupported.length > 0);
}
{
  const r = parseIntent('key A thành chuột trái', K1_CTX);
  check('VN mouse target "chuột trái" → mouse_left', keymapOp(r)?.keys.a === 'mouse_left', JSON.stringify(keymapOp(r)?.keys));
}
{
  const r = parseIntent('tạo layer navigation', K1_CTX);
  check('"tạo layer" → question (needs pairs), no op', r.ops.length === 0 && r.questions.length > 0);
}
{
  const r = parseIntent('device diagnostics', K1_CTX);
  check('diagnostics → read-only understood', r.ops.length === 0 && r.understood.length > 0);
}
{
  const r = parseIntent('caps lock thành ctrl và đèn đỏ', K1_CTX);
  check('compound VN request → 2 ops', r.ops.length === 2, `ops=${r.ops.length} q=${r.questions.join('|')}`);
  check('compound has keymap+light', r.ops.some((o) => o.op === 'set_keymap') && r.ops.some((o) => o.op === 'set_light'));
}

// ── Summary ────────────────────────────────────────────────────────────

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} FAILURES`}`);
process.exit(failures === 0 ? 0 : 1);
