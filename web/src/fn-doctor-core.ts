/**
 * Fn-layer doctor — DOM-free analysis behind the web "Fn+X does nothing"
 * diagnostic (bead oh-my-gravastar-fn-layer-doctor-yw0, web half).
 *
 * After the 2026-11-25 incident a dead Fn layer should be diagnosable
 * without guessing. This module is pure: the session/UI glue lives in
 * `./fn-doctor.ts`, which feeds it the decoded keymap tables.
 *
 * READ-ONLY contract: nothing here sends bytes. The checks are:
 *
 *   1. Every *physical* key whose Fn-layer slot (keymap arg `0x01`)
 *      reads `0x00000000` has no Fn action — listed by name.
 *   2. Slots whose value carries an unknown tag (`isOpaqueKeymapValue`,
 *      e.g. the undocumented tag-`0x08` Fn actions on the K1 Pro) are
 *      counted and flagged — they are preserved byte-identical, never
 *      treated as empty or editable.
 *   3. The Fn key itself is cross-checked in the base layer (arg
 *      `0x00`): it must still decode to an `fn` switch
 *      (`0x0D……`). An empty or rebound Fn key explains "Fn+X does
 *      nothing" even when the Fn layer table is intact.
 *
 * This module deliberately offers NO fix path — no writes, no reset
 * suggestions, nothing near cmd-17.
 */

import { decodeKeyValue, keyValueLabelOf } from './proto/khub916.ts';
import { isOpaqueKeymapValue } from './keymap-guard.ts';

/** Keymap arg of the Fn layer: `layer 1 | system 0` (spec §6 arg packing). */
export const FN_LAYER_ARG = 0x01;
/** Keymap arg of the base (primary) layer the Fn key lives on. */
export const BASE_LAYER_ARG = 0x00;

/** One flagged keymap slot. */
export interface FnDoctorSlot {
  /** Keymap table index (0-based slot number). */
  index: number;
  /** Physical key name when a layout table knows it, else `slot <n>`. */
  name: string;
  /** Raw u32 keymap value. */
  value: number;
}

export type FnKeyStatus =
  /** Base-layer slot decodes to an `fn` layer switch — Fn key is bound. */
  | 'fn'
  /** Slot reads `0x00000000` — the Fn key lost its binding. */
  | 'empty'
  /** Slot holds a non-Fn value — the key was rebound to something else. */
  | 'rebound'
  /** Base-layer table missing/too short to contain the slot. */
  | 'unreadable'
  /** No layout table for this model — the Fn key position is unknown. */
  | 'no-layout';

export interface FnDoctorFnKey {
  /** Keymap slot of the Fn key, or null when no layout table exists. */
  index: number | null;
  /** Key name from the layout table (e.g. `"Fn"`), or null. */
  name: string | null;
  /** Raw base-layer value at that slot, or null when unreadable. */
  baseValue: number | null;
  status: FnKeyStatus;
  /** Human label of `baseValue` for 'rebound' (e.g. `Macro(…)`). */
  label: string | null;
}

export interface FnDoctorReport {
  /** Keymap arg the Fn layer was read from (always `FN_LAYER_ARG`). */
  fnArg: number;
  /** Keymap arg the base layer was read from (always `BASE_LAYER_ARG`). */
  baseArg: number;
  /** Number of u32 slots in the Fn-layer read. */
  slotCount: number;
  /**
   * Physical keys whose Fn-layer value is `0x00000000` — no Fn action.
   * Only slots present in `opts.physical` are listed; when no layout
   * table exists every slot is treated as a candidate.
   */
  dead: FnDoctorSlot[];
  /**
   * Slots (physical or not) whose value decodes to an unknown tag —
   * opaque per AGENTS.md §Safety 7. Count + list; never "fixed".
   */
  opaque: FnDoctorSlot[];
  fnKey: FnDoctorFnKey;
  /**
   * True when nothing suspicious was found: no dead physical slots and
   * the Fn key (when its position is known) still decodes to `fn`.
   * Opaque slots and an unverifiable Fn key do NOT break `intact`.
   */
  intact: boolean;
  /** One-line verdict, e.g. `Fn layer intact` or `3 keys have no Fn action: …`. */
  summary: string;
}

export interface FnDoctorOptions {
  /**
   * Physical key slots: keymap index → display name. Pass `null` when
   * the model has no ported layout table — every slot is then treated
   * as a physical candidate (honest over-approximation, names become
   * `slot <n>`).
   */
  physical?: ReadonlyMap<number, string> | null;
  /**
   * Keymap slot index of the Fn key from the layout table, or `null`
   * when unknown. Callers must derive this from the vendor layout
   * table (e.g. the `"Fn"` row), never hardcode it.
   */
  fnKeyIndex?: number | null;
  /** Display name of the Fn key for messages (e.g. `"Fn"`). */
  fnKeyName?: string | null;
}

function slotName(map: ReadonlyMap<number, string> | null | undefined, index: number): string {
  return map?.get(index) ?? `slot ${index}`;
}

/**
 * Analyse the Fn layer (`fnValues`, from keymap arg `0x01`) against the
 * base layer (`baseValues`, arg `0x00`). Both are raw u32 tables in
 * slot order; `baseValues` may be shorter/empty — the Fn-key check then
 * reports `unreadable` instead of guessing.
 */
export function analyzeFnLayer(
  fnValues: readonly number[],
  baseValues: readonly number[],
  opts: FnDoctorOptions = {},
): FnDoctorReport {
  const physical = opts.physical ?? null;

  // Candidate slots for the "no Fn action" check: the physical keys
  // when a layout table exists, otherwise every slot in the read.
  const candidates: number[] =
    physical !== null
      ? [...physical.keys()].filter((i) => i >= 0 && i < fnValues.length).sort((a, b) => a - b)
      : fnValues.map((_, i) => i);

  const dead: FnDoctorSlot[] = [];
  for (const i of candidates) {
    if ((fnValues[i] ?? 0) === 0) {
      dead.push({ index: i, name: slotName(physical, i), value: 0 });
    }
  }

  const opaque: FnDoctorSlot[] = [];
  for (let i = 0; i < fnValues.length; i++) {
    const v = fnValues[i] ?? 0;
    if (isOpaqueKeymapValue(v)) {
      opaque.push({ index: i, name: slotName(physical, i), value: v >>> 0 });
    }
  }

  // ── Fn key cross-check (base layer arg 0) ──────────────────────────
  let fnKey: FnDoctorFnKey;
  const fnIndex = opts.fnKeyIndex ?? null;
  if (fnIndex === null) {
    fnKey = { index: null, name: opts.fnKeyName ?? null, baseValue: null, status: 'no-layout', label: null };
  } else {
    const name = opts.fnKeyName ?? slotName(physical, fnIndex);
    if (fnIndex < 0 || fnIndex >= baseValues.length) {
      fnKey = { index: fnIndex, name, baseValue: null, status: 'unreadable', label: null };
    } else {
      const v = (baseValues[fnIndex] ?? 0) >>> 0;
      const kv = decodeKeyValue(v);
      if (kv.kind === 'fn') {
        fnKey = { index: fnIndex, name, baseValue: v, status: 'fn', label: null };
      } else if (kv.kind === 'empty') {
        fnKey = { index: fnIndex, name, baseValue: v, status: 'empty', label: null };
      } else {
        fnKey = {
          index: fnIndex,
          name,
          baseValue: v,
          status: 'rebound',
          label: keyValueLabelOf(v),
        };
      }
    }
  }

  const fnKeyBad = fnKey.status === 'empty' || fnKey.status === 'rebound';
  const intact = dead.length === 0 && !fnKeyBad;

  const report: FnDoctorReport = {
    fnArg: FN_LAYER_ARG,
    baseArg: BASE_LAYER_ARG,
    slotCount: fnValues.length,
    dead,
    opaque,
    fnKey,
    intact,
    summary: '',
  };
  report.summary = fnDoctorSummary(report);
  return report;
}

const SUMMARY_NAME_CAP = 12;

function slotList(names: readonly string[]): string {
  if (names.length <= SUMMARY_NAME_CAP) return names.join(', ');
  return `${names.slice(0, SUMMARY_NAME_CAP).join(', ')}, +${names.length - SUMMARY_NAME_CAP} more`;
}

/**
 * One-line verdict for a report. `Fn layer intact` only when no dead
 * slots and the Fn key still switches layers; otherwise a compact
 * `N keys have no Fn action: …` style summary plus the Fn-key and
 * opaque-slot notes. Pure — used by both the UI and tests.
 */
export function fnDoctorSummary(r: FnDoctorReport): string {
  const problems: string[] = [];
  const notes: string[] = [];
  if (r.dead.length > 0) {
    problems.push(
      `${r.dead.length} key${r.dead.length === 1 ? ' has' : 's have'} no Fn action: ` +
        slotList(r.dead.map((s) => s.name)),
    );
  }
  switch (r.fnKey.status) {
    case 'empty':
      problems.push(
        `the Fn key (${r.fnKey.name ?? `slot ${r.fnKey.index}`}) has no binding in the base layer`,
      );
      break;
    case 'rebound':
      problems.push(
        `the Fn key (${r.fnKey.name ?? `slot ${r.fnKey.index}`}) is rebound to ` +
          `${r.fnKey.label ?? 'something else'} — it no longer switches to the Fn layer`,
      );
      break;
    case 'unreadable':
      notes.push('the Fn key could not be checked — the base layer read was incomplete');
      break;
    case 'no-layout':
      notes.push('the Fn key position is unknown for this model (no layout table)');
      break;
    case 'fn':
      break;
  }
  if (r.opaque.length > 0) {
    notes.push(
      `${r.opaque.length} slot${r.opaque.length === 1 ? '' : 's'} carry opaque/unknown ` +
        'values the app cannot decode (preserved as-is)',
    );
  }
  if (problems.length === 0) {
    const verdict = 'Fn layer intact';
    return notes.length > 0 ? `${verdict} (${notes.join('; ')})` : verdict;
  }
  return [...problems, ...notes].join('; ');
}
