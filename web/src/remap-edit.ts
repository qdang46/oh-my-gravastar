/**
 * Staged-edit model for the Keymap Studio (bead c8y).
 *
 * DOM-free and state-free so it can be unit-tested under plain Node
 * (`scripts/test-remap-edit.ts`). The page (`remap.ts`) owns the device
 * snapshot; this class owns ONLY the pending (unsaved) per-slot values
 * plus the undo/redo history for staged edits.
 *
 * Model:
 * - `pending[arg][index] = u32` — the value a key WILL have after Apply.
 *   A slot with no pending entry shows its committed (device-read) value.
 * - Every mutation goes through `stage()`, which records a before/after
 *   snapshot of the touched pending slots and pushes one history entry —
 *   a multi-key apply is a single undo step.
 * - `PendingSlot` snapshots use `null` for "no pending entry"; restoring
 *   a snapshot re-derives the pending map (a staged value equal to the
 *   committed value collapses back to "no pending").
 */

/** `null` = the slot has no staged value (device value is shown). */
export type PendingSlot = number | null;

export interface HistoryEntry {
  /** Keymap arg the edit touched (`layer | system<<2`, 0–7). */
  arg: number;
  /** Pending-slot values before the edit. */
  before: ReadonlyMap<number, PendingSlot>;
  /** Pending-slot values after the edit. */
  after: ReadonlyMap<number, PendingSlot>;
}

const KEYMAP_ENTRIES = 128;
const DEFAULT_MAX_HISTORY = 100;
const EMPTY: ReadonlyMap<number, number> = new Map();

export class StagedEdits {
  /** arg → slot index → staged u32 value. */
  private readonly pending = new Map<number, Map<number, number>>();
  private readonly undoStack: HistoryEntry[] = [];
  private readonly redoStack: HistoryEntry[] = [];

  private readonly committedFn: (arg: number, index: number) => number;
  private readonly maxHistory: number;

  /**
   * @param committedFn  committed (device-read) value for `(arg, index)`;
   *                     return 0 for unknown/empty slots.
   * @param maxHistory   undo depth cap (oldest entries dropped).
   */
  constructor(
    committedFn: (arg: number, index: number) => number,
    maxHistory: number = DEFAULT_MAX_HISTORY,
  ) {
    this.committedFn = committedFn;
    this.maxHistory = maxHistory;
  }

  private committed(arg: number, index: number): number {
    return this.committedFn(arg, index);
  }

  private layer(arg: number): Map<number, number> {
    let m = this.pending.get(arg);
    if (!m) {
      m = new Map();
      this.pending.set(arg, m);
    }
    return m;
  }

  /** Read-only view of an arg's staged edits; empty map when none. */
  pendingView(arg: number): ReadonlyMap<number, number> {
    return this.pending.get(arg) ?? EMPTY;
  }

  pendingCount(arg: number): number {
    return this.pending.get(arg)?.size ?? 0;
  }

  /** Args (keymap domain 0–7) with staged edits, ascending. */
  pendingArgs(): number[] {
    return [...this.pending.keys()].sort((a, b) => a - b);
  }

  /** Slot indices with staged edits on `arg`, ascending. */
  pendingIndices(arg: number): number[] {
    return [...(this.pending.get(arg)?.keys() ?? [])].sort((a, b) => a - b);
  }

  /** Effective value = staged override else committed. */
  effective(arg: number, index: number): number {
    return this.pending.get(arg)?.get(index) ?? this.committed(arg, index);
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /**
   * Stage `changes` on `arg`: `number` = new staged value, `null` =
   * revert the slot to its committed (device-read) value. A staged value
   * equal to the committed value also reverts. Returns true when an
   * undoable change was actually recorded (all-noop calls return false).
   */
  stage(arg: number, changes: ReadonlyMap<number, number | null>): boolean {
    if (changes.size === 0) return false;
    const m = this.layer(arg);
    const before = new Map<number, PendingSlot>();
    const after = new Map<number, PendingSlot>();
    let changed = false;
    for (const [index, value] of changes) {
      const prev = m.get(index) ?? null;
      before.set(index, prev);
      this.applySlot(m, arg, index, value);
      const next = m.get(index) ?? null;
      after.set(index, next);
      if (prev !== next) changed = true;
    }
    if (m.size === 0) this.pending.delete(arg);
    if (!changed) return false;
    this.undoStack.push({ arg, before, after });
    if (this.undoStack.length > this.maxHistory) this.undoStack.shift();
    this.redoStack.length = 0;
    return true;
  }

  /** Pop the newest staged edit back to its before-state. */
  undo(): boolean {
    const op = this.undoStack.pop();
    if (!op) return false;
    this.applySnapshot(op.arg, op.before);
    this.redoStack.push(op);
    return true;
  }

  /** Re-apply the most recently undone edit. */
  redo(): boolean {
    const op = this.redoStack.pop();
    if (!op) return false;
    this.applySnapshot(op.arg, op.after);
    this.undoStack.push(op);
    return true;
  }

  /** Drop all staged edits on `arg` (undoable — staged only, nothing sent). */
  clearLayer(arg: number): boolean {
    const indices = this.pendingIndices(arg);
    if (indices.length === 0) return false;
    return this.stage(
      arg,
      new Map(indices.map((i) => [i, null] as const)),
    );
  }

  /**
   * Plan a layer copy: the pending changes needed on `dst` so every slot
   * matches `src`'s *effective* values (staged overrides included).
   * Returns `null` when `src === dst`.
   */
  planCopy(src: number, dst: number): Map<number, PendingSlot> | null {
    if (src === dst) return null;
    const srcPend = this.pending.get(src);
    const dstPend = this.pending.get(dst);
    const out = new Map<number, PendingSlot>();
    for (let i = 0; i < KEYMAP_ENTRIES; i++) {
      const srcEff = srcPend?.get(i) ?? this.committed(src, i);
      const dstCommitted = this.committed(dst, i);
      // Desired pending on dst: null when src already equals dst's
      // committed value, else the src effective value itself.
      const desired: PendingSlot = srcEff === dstCommitted ? null : srcEff;
      const cur: PendingSlot = dstPend?.get(i) ?? null;
      if (desired !== cur) out.set(i, desired);
    }
    return out;
  }

  /**
   * Stage `planCopy(src, dst)` as one undoable edit.
   * Returns the number of staged slots, 0 when already identical,
   * -1 when `src === dst`.
   */
  copyLayer(src: number, dst: number): number {
    const plan = this.planCopy(src, dst);
    if (plan === null) return -1;
    if (plan.size === 0) return 0;
    return this.stage(dst, plan) ? plan.size : 0;
  }

  /**
   * Remove written slots from the pending map after a successful
   * read-back-verified write. Does NOT touch history — callers should
   * `clearHistory()` too, since committed values just changed under it.
   */
  dropWritten(arg: number, indices: Iterable<number>): void {
    const m = this.pending.get(arg);
    if (!m) return;
    for (const i of indices) m.delete(i);
    if (m.size === 0) this.pending.delete(arg);
  }

  /** Forget all undo/redo history (call after device state changes). */
  clearHistory(): void {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
  }

  // ── internals ──────────────────────────────────────────────────────

  /** Write one slot into the pending map honouring the revert rules. */
  private applySlot(
    m: Map<number, number>,
    arg: number,
    index: number,
    value: number | null,
  ): void {
    if (value === null || value === this.committed(arg, index)) {
      m.delete(index);
    } else {
      m.set(index, value >>> 0);
    }
  }

  /** Restore a before/after pending-slot snapshot onto `arg`. */
  private applySnapshot(arg: number, snap: ReadonlyMap<number, PendingSlot>): void {
    const m = this.layer(arg);
    for (const [index, value] of snap) {
      this.applySlot(m, arg, index, value);
    }
    if (m.size === 0) this.pending.delete(arg);
  }
}
