/**
 * Keymap change-diff model — bead xbp ("Review changes" / system-level
 * change preview before Apply).
 *
 * DOM-free and state-free so it can be unit-tested under plain Node
 * (`scripts/test-keymap-diff.ts`). Given a `StagedEdits` store plus the
 * committed (device-read) lookup, it produces a full-system diff of
 * EVERY staged edit across all keymap args (user + system key sets),
 * plus a one-line summary for confirm dialogs.
 *
 * Because it reads the live `StagedEdits` state on every call, the diff
 * always reflects the current staged set — stage / undo / redo / clear /
 * dropWritten all show up on the next rebuild with no extra wiring.
 *
 * Scope note: keymap staged edits are the only structured pending state
 * with before/after snapshots today. The macro and lighting pages track
 * unsaved work with in-page `dirty` flags over their own models (not a
 * shareable diff source), so this module covers keymaps only — it does
 * not fake entries for them.
 */

import { StagedEdits } from './remap-edit.ts';
import { keyValueLabelOf } from './proto/khub916.ts';
import { poolNameFor } from './keypool.ts';

/** One staged key change: slot `index` on keymap `arg`, old → new u32. */
export interface KeymapChange {
  /** Keymap arg (`layer | system<<2`, 0–7). */
  arg: number;
  /** Keymap slot index (0–127). */
  index: number;
  /** Committed (device-read) value before the staged edit. */
  oldValue: number;
  /** Staged value that will be written on Apply. */
  newValue: number;
}

/** All staged changes on one keymap arg, sorted by slot index. */
export interface KeymapDiffGroup {
  arg: number;
  changes: KeymapChange[];
}

export interface KeymapDiff {
  /** Non-empty groups, ascending by arg. */
  groups: KeymapDiffGroup[];
  /** Sum of `changes.length` over all groups. */
  totalChanges: number;
  /** Number of keymap args with staged changes. */
  affectedArgs: number;
}

/** Human label for a keymap arg (same wording as remap.ts `argLabel`). */
export function keymapArgLabel(arg: number): string {
  return arg < 4 ? `Key set ${arg + 1}` : `System key set ${arg - 3}`;
}

/** 'user' for args 0–3, 'system' for args 4–7. */
export function keymapArgSystem(arg: number): 'user' | 'system' {
  return arg < 4 ? 'user' : 'system';
}

/**
 * Build the full-system diff of everything staged in `edits`.
 *
 * @param edits        the live StagedEdits store (any staged state).
 * @param committedFn  committed value for `(arg, index)` — the same
 *                     lookup the store was constructed with; return 0
 *                     for unknown/empty slots.
 */
export function buildKeymapDiff(
  edits: StagedEdits,
  committedFn: (arg: number, index: number) => number,
): KeymapDiff {
  const groups: KeymapDiffGroup[] = [];
  let totalChanges = 0;
  for (const arg of edits.pendingArgs()) {
    const pending = edits.pendingView(arg);
    if (pending.size === 0) continue;
    const indices = edits.pendingIndices(arg);
    const changes: KeymapChange[] = indices.map((index) => ({
      arg,
      index,
      oldValue: committedFn(arg, index),
      newValue: pending.get(index) ?? 0,
    }));
    groups.push({ arg, changes });
    totalChanges += changes.length;
  }
  return { groups, totalChanges, affectedArgs: groups.length };
}

/**
 * One-line summary of a diff for buttons/dialogs, e.g.
 * "12 keys across 2 key sets" or "1 key on Key set 2".
 */
export function diffSummary(diff: KeymapDiff): string {
  const n = diff.totalChanges;
  const keys = `${n} key${n === 1 ? '' : 's'}`;
  if (diff.affectedArgs === 0) return 'no pending key changes';
  if (diff.affectedArgs === 1) {
    const arg = diff.groups[0]?.arg ?? 0;
    return `${keys} on ${keymapArgLabel(arg)}`;
  }
  return `${keys} across ${diff.affectedArgs} key sets`;
}

/**
 * Display label for a raw u32 keymap value: decoded HID label first,
 * vendor pool name as fallback, '' when unnamed (caller shows 'nothing').
 */
export function diffValueLabel(v: number): string {
  return keyValueLabelOf(v) || poolNameFor(v) || '';
}
