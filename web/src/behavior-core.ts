/**
 * Configure-key behavior model — bead vzx (per-key Easy/Advanced flow in
 * Keymap Studio, `docs/UIUX-SPEC.md` §3 "Behaviors" row and
 * `docs/vision-full-custom.md` §C).
 *
 * DOM-free and device-free so it runs under plain Node
 * (`scripts/test-behavior.ts`). This module owns ONLY the model:
 *
 * - the behavior catalog gated by `core/capabilities.ts` verdicts and
 *   `docs/protocol-behaviors.md` (unsupported behaviors are listed with
 *   their reason — never silently writable);
 * - the Easy ↔ Advanced draft mapping (tap=X/hold=Y presets are the
 *   khub916 MT / HE HK-mode-3 primitive; timing is ms in the UI, 10 ms
 *   units on the wire);
 * - draft validation + human summaries for confirm dialogs.
 *
 * It deliberately contains NO wire formats: planning stays in
 * `proto/advkey916.ts` (`planMt`/`planSocd`/`planTgl`) and
 * `proto/he.ts` (`higherKeyWriteReports`). Verdicts cited per row come
 * from `docs/protocol-behaviors.md` §5.
 */

import { ADV_FORBIDDEN_TAGS, decodeAdvBinding } from './proto/advkey916.ts';
import { KEYMAP_ENTRIES, keyValueLabelOf } from './proto/khub916.ts';
import type { Capability } from './core/capabilities.ts';
import type { ProtocolKind } from './core/device-model.ts';

// ── Behavior ids ───────────────────────────────────────────────────────

/** Behaviors this flow can actually write (staged or immediate). */
export type WritableBehaviorId = 'plain' | 'mt' | 'socd' | 'tgl';

/**
 * Inventory behaviors with NO supported wire encoding on any shipped
 * protocol (`docs/protocol-behaviors.md` §5). `macro-behavior` is
 * special: khub916 macro refs (tag 0x03) ARE supported, but binding is
 * owned by the Macro page — listed here so the flow explains where it
 * lives instead of duplicating it.
 */
export type UnavailableBehaviorId =
  | 'macro-behavior'
  | 'layer-tap'
  | 'tap-dance'
  | 'combo'
  | 'key-override'
  | 'one-shot'
  | 'sticky'
  | 'caps-word'
  | 'auto-shift'
  | 'leader'
  | 'repeat'
  | 'mod-morph'
  | 'conditional-layer';

export type BehaviorId = WritableBehaviorId | UnavailableBehaviorId;

export const BEHAVIOR_LABELS: Record<BehaviorId, string> = {
  plain: 'Single key press',
  mt: 'Tap or hold — two actions',
  socd: 'Opposing keys (SOCD)',
  tgl: 'Toggle key (TGL)',
  'macro-behavior': 'Run a macro',
  'layer-tap': 'Layer tap',
  'tap-dance': 'Tap dance',
  combo: 'Combo (multi-key trigger)',
  'key-override': 'Key override',
  'one-shot': 'One-shot',
  sticky: 'Sticky key',
  'caps-word': 'Caps word',
  'auto-shift': 'Auto shift',
  leader: 'Leader key',
  repeat: 'Repeat key',
  'mod-morph': 'Mod-morph',
  'conditional-layer': 'Conditional layer',
};

// ── Action-first card presentation (bead sl3) ─────────────────────────
//
// Progressive disclosure for the Configure-key panel: everyday actions
// are cards with plain-language titles/subtitles; jargon (SOCD/MT/TGL
// acronyms, raw parameters) stays behind "More customization" and the
// Advanced mode tab. DOM-free so scripts/test-edit-model.ts can check
// the ordering.

export interface BehaviorCardInfo {
  /** Plain-language card title (no protocol jargon). */
  title: string;
  /** One-line subtitle explaining what the user gets. */
  subtitle: string;
  /** 'primary' = shown upfront; 'advanced' = behind "More customization". */
  tier: 'primary' | 'advanced';
}

export const BEHAVIOR_CARDS: Record<WritableBehaviorId, BehaviorCardInfo> = {
  plain: {
    title: 'Normal key',
    subtitle: 'Does one thing when you press it',
    tier: 'primary',
  },
  mt: {
    title: 'Tap or hold',
    subtitle: 'A quick tap and a long press can do different things',
    tier: 'primary',
  },
  tgl: {
    title: 'Toggle',
    subtitle: 'Each press switches another key’s action on or off',
    tier: 'primary',
  },
  socd: {
    title: 'Opposing keys',
    subtitle:
      'For pairs like A/D — decides what happens when both are pressed at once (SOCD)',
    tier: 'advanced',
  },
};

/** Card presentation for a writable behavior id (null for inventory-only ids). */
export function behaviorCard(id: BehaviorId): BehaviorCardInfo | null {
  return id in BEHAVIOR_CARDS ? BEHAVIOR_CARDS[id as WritableBehaviorId] : null;
}

/**
 * Partition the usable (non-unavailable) catalog options into the
 * primary action cards and the advanced "More customization" group.
 * Catalog order is preserved inside each tier, so the primary order is
 * always Normal key → Tap or hold → Toggle.
 */
export function splitBehaviorChoices(catalog: readonly BehaviorOption[]): {
  primary: BehaviorOption[];
  advanced: BehaviorOption[];
} {
  const primary: BehaviorOption[] = [];
  const advanced: BehaviorOption[] = [];
  for (const o of catalog) {
    if (o.group === 'unavailable') continue;
    if (behaviorCard(o.id)?.tier === 'advanced') advanced.push(o);
    else primary.push(o);
  }
  return { primary, advanced };
}

// ── Catalog ────────────────────────────────────────────────────────────

export type BehaviorGroup = 'action' | 'adv' | 'unavailable';

export interface BehaviorOption {
  id: BehaviorId;
  label: string;
  group: BehaviorGroup;
  available: boolean;
  /** Why the option is unavailable (shown disabled-with-reason). */
  reason?: string;
  /** Caveat shown even when available (e.g. unverified persistence). */
  caveat?: string;
  /** 'staged' = goes through StagedEdits/Save; 'immediate' = writes now. */
  write: 'staged' | 'immediate' | 'none';
}

/** Vendor MT hold-time slider range: 0–100 × 10 ms units (≤ 1 s). */
export const MT_TIME_MAX_UNITS = 100;
export const MT_TIME_MAX_MS = MT_TIME_MAX_UNITS * 10;

/** SOCD direction labels (vendor `socdList` ids 0–3; same as advkeys.ts). */
export const SOCD_DIRECTION_LABELS: readonly string[] = [
  'Last input wins',
  'Key A priority',
  'Key B priority',
  'All cancel',
];

/** Per-protocol fallback reason for behaviors with no encoding. */
function unsupportedReason(id: UnavailableBehaviorId, protocol: ProtocolKind): string {
  switch (protocol) {
    case 'khub916':
      if (id === 'layer-tap') {
        return (
          'khub916 has a secondary-layer tag (0x07) but its write path and ' +
          'semantics are unobserved — unknown, not confirmed (docs/protocol-behaviors.md §1.2)'
        );
      }
      if (id === 'combo') {
        return (
          'the vendor "combo key" is a static chord output (modifier bits + ' +
          'one key), not a multi-key press trigger (docs/protocol-behaviors.md §1.3)'
        );
      }
      if (id === 'key-override') {
        return 'khub916 keymap values are static per slot — no press-time remap encoding';
      }
      if (id === 'macro-behavior') {
        return 'macro references (tag 0x03) are supported — bind them from the Macro page';
      }
      return (
        'khub916 exposes only SOCD/MT/TGL adv bindings — no tag, history ' +
        'region or UI exists for this (docs/protocol-behaviors.md §1.4)'
      );
    case 'he-v2':
      if (id === 'layer-tap') {
        return (
          'HE has 4 layers and Fn0–Fn3 switch keycodes, but hold-vs-toggle ' +
          'semantics are undocumented — unknown (docs/protocol-behaviors.md §2)'
        );
      }
      if (id === 'key-override') {
        return (
          'closest is HK END mode (a different key on release) — not a ' +
          'press-time override (docs/protocol-behaviors.md §2)'
        );
      }
      if (id === 'one-shot' || id === 'sticky') {
        return (
          'HK TGL mode ("tap initiates continuous triggering") is the closest ' +
          'primitive; one-shot-vs-sticky semantics are undocumented'
        );
      }
      return (
        'HE HigherKey has exactly 8 modes (NONE/DKS/MPT/MT/TGL/END/SOCD/RS) ' +
        '— none implement this (docs/protocol-behaviors.md §2)'
      );
    case 'compx':
      return (
        'Compx mouse protocol stores static shortcut/macro records only — ' +
        'no timing, layer or multi-key parameters exist ' +
        '(docs/protocol-behaviors.md §3)'
      );
    case 'sparkplayjoy':
      return (
        'SparkPlayJoy is a strictly read-only analog-capture protocol — no ' +
        'behavior encoding exists or is writable (docs/protocol-behaviors.md §4)'
      );
    default:
      return 'device protocol unrecognised — capability unknown';
  }
}

const UNAVAILABLE_ORDER: readonly UnavailableBehaviorId[] = [
  'macro-behavior',
  'layer-tap',
  'tap-dance',
  'combo',
  'key-override',
  'one-shot',
  'sticky',
  'caps-word',
  'auto-shift',
  'leader',
  'repeat',
  'mod-morph',
  'conditional-layer',
];

/**
 * Gate the adv-key behaviors (MT/SOCD/TGL) on the capability registry's
 * `adv_keys` entry plus the protocol. Returns the write mode and an
 * honest caveat/reason.
 */
function advGate(
  protocol: ProtocolKind,
  advKeys: Capability | undefined,
): { ok: boolean; caveat?: string; reason?: string } {
  if (protocol === 'he-v2') {
    // The HE HigherKey surface exists in proto/he.ts + he.ts, but the
    // Keys page only ever holds a khub916 session — say so instead of
    // offering a dead control.
    return {
      ok: false,
      reason:
        'HE HigherKey modes exist (proto/he.ts cat-6: MT/TGL/SOCD/END/DKS/MPT/RS, ' +
        'code-tested only) but this page has no HE session — use `omg kb hk`',
    };
  }
  if (protocol === 'compx') {
    return {
      ok: false,
      reason:
        'Compx mouse stores static shortcut/macro records only — no ' +
        'timing/trigger parameters exist for adv bindings',
    };
  }
  if (protocol === 'sparkplayjoy') {
    return {
      ok: false,
      reason: 'SparkPlayJoy is a strictly read-only protocol — no adv-key writes exist',
    };
  }
  if (protocol !== 'khub916') {
    return {
      ok: false,
      reason: `advanced-key bindings are a khub916 feature — ${protocol} has none`,
    };
  }
  if (!advKeys) {
    return { ok: false, reason: 'no capability data for this device' };
  }
  switch (advKeys.state) {
    case 'supported':
      return { ok: true, caveat: advKeys.reason };
    case 'unverified':
    case 'experimental':
      // khub916 today: codec + UI shipped, cmd-18 history persistence
      // unconfirmed on K1 Pro — offer it, but carry the caveat.
      return {
        ok: true,
        caveat: advKeys.reason ?? 'supported but unverified on this firmware',
      };
    default:
      return {
        ok: false,
        reason: advKeys.reason ?? `advanced keys are ${advKeys.state} on this device`,
      };
  }
}

/**
 * Full behavior catalog for the connected device: writable options
 * first (plain action, then adv kinds), then every unsupported
 * inventory behavior with its reason — the "unavailable with reason,
 * never silently writable" contract.
 */
export function behaviorCatalog(
  protocol: ProtocolKind,
  advKeys?: Capability | null,
): BehaviorOption[] {
  const out: BehaviorOption[] = [
    {
      id: 'plain',
      label: BEHAVIOR_LABELS.plain,
      group: 'action',
      available: true,
      write: 'staged',
    },
  ];
  const gate = advGate(protocol, advKeys ?? undefined);
  for (const id of ['mt', 'socd', 'tgl'] as const) {
    out.push({
      id,
      label: BEHAVIOR_LABELS[id],
      group: 'adv',
      available: gate.ok,
      reason: gate.ok ? undefined : gate.reason,
      caveat: gate.ok ? gate.caveat : undefined,
      write: gate.ok ? 'immediate' : 'none',
    });
  }
  for (const id of UNAVAILABLE_ORDER) {
    out.push({
      id,
      label: BEHAVIOR_LABELS[id],
      group: 'unavailable',
      available: false,
      reason: unsupportedReason(id, protocol),
      write: 'none',
    });
  }
  return out;
}

// ── Drafts (Easy = same fields, friendlier widgets) ────────────────────

export interface MtDraft {
  kind: 'mt';
  /** Raw u32 key values emitted on tap / hold (0 = none). */
  tap: number;
  hold: number;
  /** Hold threshold in 10 ms units (0–100, vendor slider range). */
  timeUnits: number;
}

export interface SocdDraft {
  kind: 'socd';
  /** Keymap indices of the two physical keys. */
  keyA: number;
  keyB: number;
  /** Vendor direction id 0–3 (`SOCD_DIRECTION_LABELS`). */
  direction: number;
}

export interface TglDraft {
  kind: 'tgl';
  /** Keymap index of the physical bind key. */
  key: number;
  /** Keymap index whose stored value is toggled. */
  target: number;
}

export type AdvDraft = MtDraft | SocdDraft | TglDraft;

/** ms → wire units: `Math.round(ms/10)`, must land in 0–100. */
export function mtUnitsFromMs(ms: number): number | null {
  if (!Number.isFinite(ms) || ms < 0 || ms > MT_TIME_MAX_MS) return null;
  const units = Math.round(ms / 10);
  return units >= 0 && units <= MT_TIME_MAX_UNITS ? units : null;
}

/** Wire units → display ms. */
export function mtMsFromUnits(units: number): number {
  return units * 10;
}

/**
 * Parse a raw keymap value typed by the user: `0x` hex, decimal, or
 * the words `none`/`0` for an empty value. Returns null when invalid.
 */
export function parseU32Input(text: string): number | null {
  const t = text.trim().toLowerCase();
  if (t === '' || t === 'none') return 0;
  let v: number;
  if (t.startsWith('0x')) {
    if (!/^[0-9a-f]{1,8}$/.test(t.slice(2))) return null;
    v = Number.parseInt(t.slice(2), 16);
  } else {
    if (!/^[0-9]{1,10}$/.test(t)) return null;
    v = Number.parseInt(t, 10);
  }
  if (!Number.isInteger(v) || v < 0 || v > 0xffff_ffff) return null;
  return v >>> 0;
}

/** True when a u32 carries a macro/SOCD/MT/TGL tag (unbind first). */
export function hasForbiddenTag(value: number): boolean {
  return ADV_FORBIDDEN_TAGS.includes((value >>> 24) & 0xff);
}

function checkIndex(index: number, what: string, keymapLen: number): string | null {
  if (!Number.isInteger(index) || index < 0 || index >= keymapLen) {
    return `${what} must be a key position 0–${keymapLen - 1}`;
  }
  return null;
}

/** Validate an MT draft; returns an error string or null. */
export function validateMtDraft(d: MtDraft, keymapLen = KEYMAP_ENTRIES): string | null {
  if (hasForbiddenTag(d.tap)) return 'tap value carries a macro/advanced-key tag — pick a plain key';
  if (hasForbiddenTag(d.hold)) return 'hold value carries a macro/advanced-key tag — pick a plain key';
  if (!Number.isInteger(d.timeUnits) || d.timeUnits < 0 || d.timeUnits > MT_TIME_MAX_UNITS) {
    return `hold time must be a whole number of ms between 0 and ${MT_TIME_MAX_MS}`;
  }
  void keymapLen;
  return null;
}

/** Validate a SOCD draft; `keyA` is the configured key itself. */
export function validateSocdDraft(d: SocdDraft, keymapLen = KEYMAP_ENTRIES): string | null {
  const a = checkIndex(d.keyA, 'key A', keymapLen);
  if (a) return a;
  const b = checkIndex(d.keyB, 'key B', keymapLen);
  if (b) return b;
  if (d.keyA === d.keyB) return 'SOCD needs two different keys';
  if (!Number.isInteger(d.direction) || d.direction < 0 || d.direction > 3) {
    return 'direction must be 0–3';
  }
  return null;
}

/** Validate a TGL draft; `key` is the configured key itself. */
export function validateTglDraft(d: TglDraft, keymapLen = KEYMAP_ENTRIES): string | null {
  const k = checkIndex(d.key, 'bind key', keymapLen);
  if (k) return k;
  return checkIndex(d.target, 'toggle target', keymapLen);
}

/** Validate any adv draft (dispatch on kind). */
export function validateAdvDraft(d: AdvDraft, keymapLen = KEYMAP_ENTRIES): string | null {
  switch (d.kind) {
    case 'mt':
      return validateMtDraft(d, keymapLen);
    case 'socd':
      return validateSocdDraft(d, keymapLen);
    case 'tgl':
      return validateTglDraft(d, keymapLen);
  }
}

/**
 * One-line human summary of an adv draft for confirm dialogs/status.
 * `keyLabel(i)` names a keymap slot; `valueLabel(v)` names a u32 value.
 */
export function describeAdvDraft(
  d: AdvDraft,
  bindIndex: number,
  keyLabel: (index: number) => string,
  valueLabelFn: (value: number) => string,
): string {
  const vl = (v: number): string => valueLabelFn(v) || `0x${(v >>> 0).toString(16).toUpperCase().padStart(8, '0')}`;
  switch (d.kind) {
    case 'mt':
      return (
        `MT on ${keyLabel(bindIndex)}: tap ${vl(d.tap)}, hold ${vl(d.hold)}, ` +
        `after ${mtMsFromUnits(d.timeUnits)} ms`
      );
    case 'socd':
      return (
        `SOCD on ${keyLabel(d.keyA)} + ${keyLabel(d.keyB)}: ` +
        `${SOCD_DIRECTION_LABELS[d.direction] ?? `mode ${d.direction}`}`
      );
    case 'tgl':
      return `TGL on ${keyLabel(d.key)} toggles ${keyLabel(d.target)}`;
  }
}

/** Plain-language summary of an existing adv binding value (or null). */
export function currentBehaviorSummary(value: number): string | null {
  const d = decodeAdvBinding(value);
  if (!d) return null;
  switch (d.kind) {
    case 'mt':
      return `MT — hold after ${d.detail.kind === 'mt' ? d.detail.time * 10 : '?'} ms`;
    case 'socd': {
      const dir = d.detail.kind === 'socd' ? d.detail.direction : 0;
      return `SOCD — ${SOCD_DIRECTION_LABELS[dir] ?? `mode ${dir}`}`;
    }
    case 'tgl':
      return 'TGL — toggle';
  }
}

/** Display label for a raw u32 keymap value ('' when unnamed). */
export function behaviorValueLabel(v: number): string {
  return keyValueLabelOf(v) || '';
}
