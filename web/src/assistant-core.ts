/**
 * Assistant core — DOM-free logic for the AI Assistant page
 * (bead oh-my-gravastar-7js PART 2, `web/src/assistant.ts`).
 *
 * The NL parser (`agent/intent.ts`) emits `OpInput` drafts whose key
 * references are canonical NAMES (`caps_lock`, `left_ctrl`, …). The
 * agent pipeline (`planner.ts`/`action-schema.ts`) only accepts schema
 * ops: `set_keymap` needs concrete `{index, value}` entries,
 * `set_macro.bind_key` a slot index, `set_adv.tap/hold` raw u32 values
 * and `restore_snapshot` a concrete snapshot id. This module lowers
 * `OpInput[]` → schema ops and produces the human-facing strings the
 * page renders (op descriptions, question chips, capability hints).
 *
 * API gaps worked around here (agent/ internals are frozen):
 * - `intent.ts::KEY_SPEC` (canonical → vendor layout names + keypool
 *   name) is private, so `CANON` below mirrors it — keep in sync.
 * - `planner.ts::resolveKeyRef` only resolves `set_adv` refs and only
 *   against raw layout names, so ALL name resolution happens here.
 *
 * Everything is pure — safe under Node's type stripping
 * (`scripts/test-assistant.ts`). No DOM, no device, no network.
 */

import { KEY_POOL } from './keypool.ts';
import { keyIndexOf, type KeyBlock } from './k1pro-layout.ts';
import { LIGHT_MODES } from './proto/light.ts';
import { isFeatureAvailable, FEATURE_REGISTRY } from './core/feature-registry.ts';
import type { CapabilityMap } from './core/capabilities.ts';
import type { OpInput } from './agent/intent.ts';
import type { SnapshotMeta } from './safety/snapshots.ts';

// ── Canonical key → vendor names ───────────────────────────────────────

/**
 * Mirror of `agent/intent.ts::KEY_SPEC` (private there): `layout` lists
 * the vendor `KeyBlock.name` spellings tried in order when resolving a
 * physical slot; `pool` is the `keypool.ts` entry name whose u32 value
 * is written as the target. Mouse buttons have no layout slot.
 */
interface CanonSpec {
  layout: string[];
  pool?: string;
}

const CANON: Record<string, CanonSpec> = {
  esc: { layout: ['ESC'], pool: 'ESC' },
  tab: { layout: ['Tab'], pool: 'Tab' },
  caps_lock: { layout: ['Caps', 'CapsLock'], pool: 'Caps' },
  backspace: { layout: ['Back', 'Backspace'], pool: 'Back' },
  enter: { layout: ['Enter', 'Return'], pool: 'Enter' },
  space: { layout: ['Space'], pool: 'Space' },
  delete: { layout: ['Del', 'Delete'], pool: 'Del' },
  insert: { layout: ['Ins', 'Insert'], pool: 'Ins' },
  home: { layout: ['Home'], pool: 'Home' },
  end: { layout: ['End'], pool: 'End' },
  page_up: { layout: ['PgUp', 'PageUp'], pool: 'PgUp' },
  page_down: { layout: ['PgDown', 'PgDn', 'PageDown'], pool: 'PgDn' },
  print_screen: { layout: ['Print', 'PrintScreen'], pool: 'Print' },
  scroll_lock: { layout: ['Scroll', 'ScrollLock'], pool: 'Scroll' },
  left_ctrl: { layout: ['L_Ctrl', 'ControlLeft'], pool: 'L_Ctrl' },
  right_ctrl: { layout: ['R_Ctrl', 'ControlRight'], pool: 'R_Ctrl' },
  left_shift: { layout: ['L_shift', 'ShiftLeft', 'LShift'], pool: 'L_shift' },
  right_shift: { layout: ['R_shift', 'ShiftRight', 'RShift'], pool: 'R_shift' },
  left_alt: { layout: ['L_Alt', 'AltLeft'], pool: 'L_Alt' },
  right_alt: { layout: ['R_Alt', 'AltRight'], pool: 'R_Alt' },
  left_win: { layout: ['L_WIN', 'MetaLeft', 'LWin'], pool: 'L_WIN' },
  right_win: { layout: ['R_WIN', 'MetaRight', 'RWin'], pool: 'R_WIN' },
  fn: { layout: ['Fn'], pool: 'Fn' },
  arrow_up: { layout: ['Up', 'ArrowUp'], pool: 'Up' },
  arrow_down: { layout: ['Down', 'ArrowDown'], pool: 'Down' },
  arrow_left: { layout: ['left', 'Left', 'ArrowLeft'], pool: 'left' },
  arrow_right: { layout: ['right', 'Right', 'ArrowRight'], pool: 'right' },
  volume_up: { layout: ['volume-up'], pool: 'volume-up' },
  volume_down: { layout: ['volume-down'], pool: 'volume-down' },
  mute: { layout: ['mute'], pool: 'mute' },
  play_pause: { layout: ['play-pause'], pool: 'play-pause' },
  previous_song: { layout: ['previous-song'], pool: 'previous-song' },
  next_song: { layout: ['next-song'], pool: 'next-song' },
  calculator: { layout: ['calculator'], pool: 'calculator' },
  browser: { layout: ['browser'], pool: 'browser' },
  my_computer: { layout: ['my-computer'], pool: 'my-computer' },
  task_manager: { layout: ['task-manager'], pool: 'task-manager' },
  mouse_left: { layout: [], pool: 'mouse-left' },
  mouse_right: { layout: [], pool: 'mouse-right' },
  mouse_middle: { layout: [], pool: 'mouse-middle' },
};

for (let i = 1; i <= 12; i++) {
  CANON[`f${i}`] = { layout: [`F${i}`], pool: `F${i}` };
}
for (const ch of 'abcdefghijklmnopqrstuvwxyz') {
  CANON[ch] = { layout: [ch.toUpperCase()], pool: ch.toUpperCase() };
}
for (const d of '0123456789') {
  CANON[d] = { layout: [d], pool: d };
}

/** First vendor layout name for a canonical key (for error messages). */
function vendorName(canon: string): string {
  return CANON[canon]?.layout[0] ?? canon;
}

// ── Name → index / value resolution ────────────────────────────────────

/**
 * Keymap slot index for a key reference. Accepts canonical names
 * (`caps_lock`), vendor layout names (`Caps`, `L_Ctrl`) and raw indices.
 * Mirrors `intent.ts::layoutIndexOf` + `planner.ts::resolveKeyRef`.
 */
export function keyRefToIndex(
  ref: string | number,
  layout: readonly KeyBlock[] | undefined,
): number | null {
  if (typeof ref === 'number') return Number.isInteger(ref) ? ref : null;
  const blocks = layout ?? [];
  const want = ref.trim().toLowerCase();
  // Canonical name → try each vendor spelling in order.
  const spec = CANON[want] ?? CANON[ref.trim()];
  const names = spec?.layout ?? [ref.trim()];
  for (const name of names) {
    const w = name.toLowerCase();
    for (const b of blocks) {
      if (b.display && b.name.toLowerCase() === w) return keyIndexOf(b.pos);
    }
  }
  // Last resort: the ref itself is a vendor layout name.
  if (!spec) {
    for (const b of blocks) {
      if (b.display && b.name.toLowerCase() === want) return keyIndexOf(b.pos);
    }
  }
  return null;
}

/**
 * Writable u32 keymap value for a canonical key name — the keypool
 * entry `intent.ts::KEY_SPEC.pool` points at. Returns null for names
 * with no pool entry (should not happen for parser output).
 */
export function keyRefToValue(ref: string | number): number | null {
  if (typeof ref === 'number') return Number.isInteger(ref) ? ref >>> 0 : null;
  const canon = CANON[ref.trim().toLowerCase()];
  if (!canon?.pool) return null;
  const entry = KEY_POOL.find((e) => e.name === canon.pool);
  return entry ? entry.value >>> 0 : null;
}

// ── OpInput → schema op lowering ───────────────────────────────────────

/** What the lowering needs from the device side (subset of DeviceContext). */
export interface LowerContext {
  layout?: readonly KeyBlock[];
  snapshots?: readonly Pick<SnapshotMeta, 'id' | 'label' | 'ts'>[];
}

export interface LoweredOps {
  /** Schema-v1 op objects, ready for `planFromOps`/`validateOp`. */
  ops: Record<string, unknown>[];
  /** Human-readable lowering problems — non-empty means do not apply. */
  problems: string[];
}

function lowerSetKeymap(
  op: Extract<OpInput, { op: 'set_keymap' }>,
  ctx: LowerContext | undefined,
  problems: string[],
): Record<string, unknown> | null {
  const entries: { index: number; value: number }[] = [];
  const seen = new Set<number>();
  for (const [src, dst] of Object.entries(op.keys)) {
    const index = keyRefToIndex(src, ctx?.layout);
    if (index === null || index < 0 || index >= 128) {
      problems.push(`key "${src}" is not on the connected keyboard layout`);
      continue;
    }
    const value = keyRefToValue(dst);
    if (value === null) {
      problems.push(`"${dst}" has no writable key value on this keyboard`);
      continue;
    }
    if (seen.has(index)) continue; // first pair wins; dupes noted by parser order
    seen.add(index);
    entries.push({ index, value });
  }
  if (entries.length === 0) {
    problems.push('keymap change: no key pairs could be resolved');
    return null;
  }
  return {
    op: 'set_keymap',
    device_selector: op.device_selector,
    layer: op.layer,
    ...(op.system !== undefined ? { system: op.system } : {}),
    entries,
  };
}

function lowerSetMacro(
  op: Extract<OpInput, { op: 'set_macro' }>,
  ctx: LowerContext | undefined,
  problems: string[],
): Record<string, unknown> | null {
  const out: Record<string, unknown> = {
    op: 'set_macro',
    device_selector: op.device_selector,
  };
  if (op.name !== undefined) out.name = op.name;
  if (op.steps !== undefined) out.steps = op.steps;
  if (op.delete === true) out.delete = true;
  if (op.bind_key !== undefined) {
    const idx = keyRefToIndex(op.bind_key, ctx?.layout);
    if (idx === null || idx < 0 || idx >= 128) {
      problems.push(`macro bind key "${String(op.bind_key)}" is not on the connected layout`);
      return null;
    }
    out.bind_key = idx;
  }
  return out;
}

function lowerSetAdv(
  op: Extract<OpInput, { op: 'set_adv' }>,
  ctx: LowerContext | undefined,
  problems: string[],
): Record<string, unknown> | null {
  const out: Record<string, unknown> = {
    op: 'set_adv',
    device_selector: op.device_selector,
    mode: op.mode,
  };
  const resolveKey = (v: string | number | undefined, what: string): number | string | undefined => {
    if (v === undefined) return undefined;
    if (typeof v === 'number') return v;
    const idx = keyRefToIndex(v, ctx?.layout);
    if (idx === null) {
      problems.push(`advanced-key ${what} "${v}" is not on the connected layout`);
      return undefined;
    }
    return idx;
  };
  const resolveValue = (v: string | number | undefined, what: string): number | string | undefined => {
    if (v === undefined) return undefined;
    const val = keyRefToValue(v);
    if (val === null) {
      problems.push(`advanced-key ${what} "${String(v)}" has no writable key value`);
      return undefined;
    }
    return val;
  };
  const key = resolveKey(op.key, 'key');
  const keyA = resolveKey(op.key_a, 'key_a');
  const keyB = resolveKey(op.key_b, 'key_b');
  const toggle = resolveKey(op.toggle, 'toggle');
  const tap = resolveValue(op.tap, 'tap');
  const hold = resolveValue(op.hold, 'hold');
  if (key !== undefined) out.key = key;
  if (keyA !== undefined) out.key_a = keyA;
  if (keyB !== undefined) out.key_b = keyB;
  if (toggle !== undefined) out.toggle = toggle;
  if (tap !== undefined) out.tap = tap;
  if (hold !== undefined) out.hold = hold;
  if (op.hold_ms !== undefined) out.hold_ms = op.hold_ms;
  if (op.direction !== undefined) out.direction = op.direction;
  return out;
}

function lowerRestoreSnapshot(
  op: Extract<OpInput, { op: 'restore_snapshot' }>,
  ctx: LowerContext | undefined,
  problems: string[],
): Record<string, unknown> | null {
  let id = op.id;
  if (id === undefined) {
    // `latest: true` or an unresolved ask → newest snapshot by timestamp.
    const snaps = [...(ctx?.snapshots ?? [])].sort((a, b) => b.ts.localeCompare(a.ts));
    id = snaps[0]?.id;
    if (id === undefined) {
      problems.push('restore snapshot: no snapshot id and no snapshots are stored');
      return null;
    }
  }
  return {
    op: 'restore_snapshot',
    device_selector: op.device_selector,
    id,
    ...(op.sections !== undefined ? { sections: op.sections } : {}),
  };
}

/**
 * Lower parser `OpInput`s to schema-v1 ops for `planFromOps`.
 * Ops that cannot be resolved are dropped and reported in `problems`
 * (the page shows them as errors and refuses to apply).
 */
export function lowerOpInputs(
  ops: readonly OpInput[],
  ctx?: LowerContext,
): LoweredOps {
  const out: LoweredOps = { ops: [], problems: [] };
  for (const op of ops) {
    let lowered: Record<string, unknown> | null = null;
    switch (op.op) {
      case 'set_keymap':
        lowered = lowerSetKeymap(op, ctx, out.problems);
        break;
      case 'set_light':
        lowered = {
          op: 'set_light',
          device_selector: op.device_selector,
          config: op.config,
        };
        break;
      case 'set_macro':
        lowered = lowerSetMacro(op, ctx, out.problems);
        break;
      case 'set_adv':
        lowered = lowerSetAdv(op, ctx, out.problems);
        break;
      case 'restore_snapshot':
        lowered = lowerRestoreSnapshot(op, ctx, out.problems);
        break;
      case 'set_profile_section':
        lowered = {
          op: 'set_profile_section',
          device_selector: op.device_selector,
          section: op.section,
          value: op.value,
        };
        break;
    }
    if (lowered) out.ops.push(lowered);
  }
  return out;
}

// ── Human-readable op descriptions ─────────────────────────────────────

function fmtKeysRecord(keys: Record<string, string>): string {
  return Object.entries(keys)
    .map(([s, d]) => `${vendorName(s)}→${vendorName(d)}`)
    .join(', ');
}

function lightModeName(id: unknown): string {
  if (typeof id !== 'number') return String(id);
  return LIGHT_MODES.find((m) => m.id === id)?.name ?? `mode ${id}`;
}

/**
 * One-line human description of a parsed op — used for the "what I
 * understood" plan cards before schema lowering.
 */
export function describeOpInput(op: OpInput): string {
  switch (op.op) {
    case 'set_keymap': {
      const sys = op.system ? ` system ${op.system}` : '';
      return `Keymap layer ${op.layer}${sys}: ${fmtKeysRecord(op.keys)}`;
    }
    case 'set_light': {
      const c = op.config;
      const parts: string[] = [];
      if (c.mode !== undefined) parts.push(lightModeName(c.mode));
      if (c.color !== undefined) parts.push(String(c.color));
      if (c.brightness !== undefined) parts.push(`brightness ${String(c.brightness)}/20`);
      if (c.speed !== undefined) parts.push(`speed ${String(c.speed)}`);
      const keys = c.keys as Record<string, unknown> | undefined;
      if (keys && Array.isArray(keys.colors)) parts.push('per-key colours (custom mode)');
      if (keys && Array.isArray(keys.entries)) parts.push(`${keys.entries.length} per-key colour change(s)`);
      return `Lighting: ${parts.join(', ') || 'config update'}`;
    }
    case 'set_macro': {
      if (op.delete) return `Delete macro "${op.name ?? '?'}"`;
      const steps = Array.isArray(op.steps)
        ? op.steps.length
        : typeof op.steps === 'object' && op.steps !== null && Array.isArray((op.steps as { steps?: unknown }).steps)
          ? ((op.steps as { steps: unknown[] }).steps.length)
          : 0;
      const bind = op.bind_key !== undefined ? `, bound to ${String(op.bind_key)}` : '';
      return `Macro "${op.name ?? 'new'}": ${steps} step(s)${bind}`;
    }
    case 'set_adv': {
      if (op.mode === 'mt') {
        return `Mod-tap on ${String(op.key)}: tap=${String(op.tap)} hold=${String(op.hold)}`;
      }
      if (op.mode === 'socd') {
        return `SOCD ${String(op.key_a)}/${String(op.key_b)}`;
      }
      return `Toggle ${String(op.key)} → ${String(op.toggle)}`;
    }
    case 'restore_snapshot': {
      const secs = op.sections?.length ? ` (${op.sections.join(', ')})` : '';
      return `Restore snapshot ${op.id ?? (op.latest ? '"latest"' : '?')}${secs}`;
    }
    case 'set_profile_section':
      return `Sleep timeout = ${op.value}s`;
  }
}

// ── Question chips ─────────────────────────────────────────────────────

export interface QuestionChip {
  /** Button label shown to the user. */
  label: string;
  /** Text appended to the original request when the chip is clicked. */
  append: string;
}

/**
 * Derive clickable follow-up chips for a parser question. Chips append
 * a candidate to the ORIGINAL request (the parser re-scores snapshots /
 * macros / layer numbers against the combined text). Returns [] when no
 * candidates are known — the question text alone is shown then.
 */
export function questionChips(
  question: string,
  ctx?: { snapshots?: readonly Pick<SnapshotMeta, 'id' | 'label' | 'ts'>[]; macros?: readonly { name: string }[] },
): QuestionChip[] {
  const chips: QuestionChip[] = [];

  if (/which snapshot/i.test(question)) {
    for (const s of (ctx?.snapshots ?? []).slice(0, 4)) {
      chips.push({ label: `Restore "${s.label}"`, append: s.label });
    }
    return chips;
  }

  if (/which macro/i.test(question)) {
    for (const m of (ctx?.macros ?? []).slice(0, 4)) {
      chips.push({ label: `Macro "${m.name}"`, append: m.name });
    }
    return chips;
  }

  // "…which layer…(1–4)?" — the parser reads "layer N" as key set N.
  if (/layer/i.test(question) && /1\s*[–—-]\s*4/.test(question)) {
    for (let n = 1; n <= 4; n++) {
      chips.push({ label: `Layer ${n}`, append: `layer ${n}` });
    }
    return chips;
  }

  // "Candidates: a, b, c." / "Known: a, b." — generic candidate lists.
  const m = /(?:candidates?|known)\s*:\s*(.+?)\.?\s*$/i.exec(question);
  if (m?.[1]) {
    for (const cand of m[1].split(',').map((s) => s.trim()).filter(Boolean).slice(0, 4)) {
      chips.push({ label: cand, append: cand });
    }
  }
  return chips;
}

// ── Capability hints ───────────────────────────────────────────────────

/**
 * "What IS possible on this device" — registry features the capability
 * map reports as usable (supported / experimental / unverified). Used
 * for the honest empty state after an unsupported request.
 */
export function possibleFeatures(caps: CapabilityMap | undefined): string[] {
  if (!caps) return [];
  const out: string[] = [];
  for (const [id, def] of Object.entries(FEATURE_REGISTRY)) {
    if (isFeatureAvailable(caps, id)) out.push(def.label);
  }
  return out;
}
