/**
 * Snapshot restore — vision-full-custom.md §4.2 "multi-section restore
 * partial failure → journal + rollback plan" and §4.4 recovery types
 * (restore point; undo ≠ factory reset).
 *
 * `restoreSnapshot` writes a stored snapshot's sections back through the
 * session's existing write APIs — the same read-back-verified methods the
 * pages use (`writeKeymap`, `writeLightData`, `writeCustomLightColors`,
 * `writeMacroRegion`, `writeProfile`). Writes go through
 * `runTransaction`, so policy approval, sequential execution, stop-on-
 * failure and the honest journal all apply. A section that fails is
 * reported per-section; nothing claims full success on a partial restore.
 */

import { hexToBytes } from './validation.ts';
import {
  runTransaction,
  type PlannedOp,
  type TransactionOptions,
  type TransactionResult,
  type WriteOutcomeLike,
} from './transaction.ts';
import {
  SnapshotStore,
  type DeviceSnapshot,
  type SnapshotRgb,
  type SnapshotSectionName,
  type SnapshotSections,
} from './snapshots.ts';

/**
 * Write side of a khub916 session — satisfied structurally by
 * `Khub916Session` (hid.ts). All methods optional so partial writers
 * (e.g. tests, future sessions) degrade to honest per-section failures.
 */
export interface RestoreWriter {
  writeKeymap?(
    layer: number,
    system: number,
    values: readonly number[],
  ): Promise<WriteOutcomeLike>;
  writeLightData?(data: Uint8Array): Promise<WriteOutcomeLike>;
  writeCustomLightColors?(colors: readonly SnapshotRgb[]): Promise<WriteOutcomeLike>;
  writeMacroRegion?(data: Uint8Array): Promise<WriteOutcomeLike>;
  writeProfile?(blob: Uint8Array): Promise<WriteOutcomeLike>;
}

export interface RestoreOptions extends TransactionOptions {
  /** The connected session's write methods. */
  writer: RestoreWriter;
  /**
   * Sections to restore; default = every section present in the
   * snapshot. Order is fixed: keymap → lighting → macro → profile.
   */
  sections?: readonly SnapshotSectionName[];
}

export interface SectionResult {
  section: SnapshotSectionName;
  result: 'success' | 'failed' | 'unverified' | 'skipped';
  detail?: string;
}

export interface RestoreResult {
  snapshotId: string;
  label: string;
  sections: SectionResult[];
  tx: TransactionResult;
}

const SECTION_ORDER: readonly SnapshotSectionName[] = ['keymap', 'lighting', 'macro', 'profile'];

function needWriter<T>(fn: T | undefined, name: string): T {
  if (fn === undefined) {
    throw new Error(`restore: no ${name} write path on this session`);
  }
  return fn;
}

function hexOp(
  hex: string | undefined,
  maxBytes: number,
  what: string,
): Uint8Array {
  const bytes = hex !== undefined ? hexToBytes(hex) : null;
  if (bytes === null || bytes.length === 0 || bytes.length > maxBytes) {
    throw new Error(`restore: stored ${what} is missing or has an invalid size`);
  }
  return bytes;
}

/**
 * Build the planned write ops for a snapshot (or a subset of its
 * sections) WITHOUT executing them — feed to `dryRun()` for a preview or
 * to `runTransaction()` directly.
 */
export function planRestore(
  snapshot: DeviceSnapshot,
  writer: RestoreWriter,
  sections?: readonly SnapshotSectionName[],
): PlannedOp[] {
  const wanted = new Set<SnapshotSectionName>(sections ?? SECTION_ORDER);
  const ops: PlannedOp[] = [];
  const s: SnapshotSections = snapshot.sections;

  if (wanted.has('keymap') && s.keymap) {
    for (const argStr of Object.keys(s.keymap).sort((a, b) => Number(a) - Number(b))) {
      const arg = Number(argStr);
      const values = s.keymap[argStr];
      if (!Number.isInteger(arg) || arg < 0 || arg > 7 || !Array.isArray(values)) continue;
      ops.push({
        type: 'keymap_write',
        section: 'keymap',
        label: `keymap set ${arg} (${values.length} keys)`,
        payload: { arg, count: values.length },
        apply: async () => {
          const w = needWriter(writer.writeKeymap, 'keymap');
          // arg packs layer | system<<2 — same split as parseProfileImport.
          return w.call(writer, arg & 3, (arg >> 2) & 1, values);
        },
      });
    }
  }

  if (wanted.has('lighting') && s.lighting) {
    const light = s.lighting;
    if (light.lightData !== undefined) {
      ops.push({
        type: 'light_write',
        section: 'lighting',
        label: 'lighting effect data',
        apply: async () => {
          const w = needWriter(writer.writeLightData, 'light-data');
          return w.call(writer, hexOp(light.lightData, 506, 'light data'));
        },
      });
    }
    if (light.colors !== undefined) {
      ops.push({
        type: 'light_write',
        section: 'lighting',
        label: `per-key colours (${light.colors.length} slots)`,
        payload: { count: light.colors.length },
        apply: async () => {
          const w = needWriter(writer.writeCustomLightColors, 'custom-light-colours');
          return w.call(writer, light.colors as SnapshotRgb[]);
        },
      });
    }
  }

  if (wanted.has('macro') && s.macro !== undefined) {
    ops.push({
      type: 'macro_write',
      section: 'macro',
      label: 'macro region',
      apply: async () => {
        const w = needWriter(writer.writeMacroRegion, 'macro-region');
        return w.call(writer, hexOp(s.macro, 512, 'macro region'));
      },
    });
  }

  if (wanted.has('profile') && s.profile !== undefined) {
    ops.push({
      type: 'settings_write',
      section: 'profile',
      label: 'profile blob',
      apply: async () => {
        const w = needWriter(writer.writeProfile, 'profile');
        return w.call(writer, hexOp(s.profile, 512, 'profile blob'));
      },
    });
  }

  return ops;
}

function aggregateSection(
  section: SnapshotSectionName,
  entries: TransactionResult['journal'],
  transactionStopped: boolean,
): SectionResult {
  const mine = entries.filter((e) => e.section === section);
  if (mine.length === 0) {
    // No journal entries: either nothing was planned for the section, or
    // the transaction stopped before reaching it — say which honestly.
    return transactionStopped
      ? { section, result: 'skipped', detail: 'not reached — an earlier section failed' }
      : { section, result: 'skipped', detail: 'no ops planned for this section' };
  }
  if (mine.some((e) => e.result === 'failed')) {
    const first = mine.find((e) => e.result === 'failed');
    return { section, result: 'failed', detail: first?.error };
  }
  if (mine.some((e) => e.result === 'unverified')) {
    return { section, result: 'unverified', detail: 'sent but read-back did not confirm' };
  }
  return { section, result: 'success' };
}

/**
 * Restore `snapshotId` from the store. Returns per-section results plus
 * the full transaction journal — check `tx.ok`/`tx.completed` for the
 * honest overall outcome.
 */
export async function restoreSnapshot(
  store: SnapshotStore,
  snapshotId: string,
  opts: RestoreOptions,
): Promise<RestoreResult> {
  const snap = store.get(snapshotId);
  if (!snap) {
    throw new Error(`no snapshot '${snapshotId}' — it may have been pruned`);
  }
  const wanted = opts.sections ?? SECTION_ORDER;
  const ops = planRestore(snap, opts.writer, wanted);
  const tx = await runTransaction(ops, {
    approve: opts.approve,
    audit: opts.audit,
    session: opts.session,
  });

  // Sections that were requested but absent from the snapshot are
  // reported skipped; present sections aggregate their journal entries.
  const present = new Set(
    (Object.keys(snap.sections) as SnapshotSectionName[]).filter(
      (s) => snap.sections[s] !== undefined,
    ),
  );
  const sections: SectionResult[] = wanted.map((name) => {
    if (!present.has(name)) {
      return { section: name, result: 'skipped', detail: 'not present in this snapshot' };
    }
    return aggregateSection(name, tx.journal, !tx.completed);
  });

  return { snapshotId: snap.id, label: snap.label, sections, tx };
}

/**
 * Restore the most recent snapshot (newest in the store index).
 * Returns null when the store is empty.
 */
export async function restoreLast(
  store: SnapshotStore,
  opts: RestoreOptions,
): Promise<RestoreResult | null> {
  const newest = store.list()[0];
  if (!newest) return null;
  return restoreSnapshot(store, newest.id, opts);
}

// ── Partial-failure rollback (SAFETY-SPEC §5 R2) ───────────────────────

export interface RollbackUnavailable {
  section: SnapshotSectionName;
  detail: string;
}

export interface RollbackOutcome {
  /** Requested sections, deduped into canonical write order. */
  requested: SnapshotSectionName[];
  /**
   * Requested sections with no payload in the snapshot — there is
   * nothing to write back, so they are listed, never silently skipped.
   */
  unavailable: RollbackUnavailable[];
  /** Per-section aggregate of the rollback transaction. */
  sections: SectionResult[];
  tx: TransactionResult;
  /** Sections whose prior values were written back (success or sent-unverified). */
  rolledBack: number;
  /** Sections whose rollback write failed. */
  failed: number;
}

/**
 * Best-effort rollback of `sections` from `snapshot` — the R2 fix for a
 * multi-section write that stopped part-way: write the pre-write values
 * back for exactly the sections that were touched. Runs through
 * `runTransaction`, so it stops on the first rollback failure and
 * journals honestly; callers MUST report `rolledBack`/`failed`/
 * `unavailable` — never claim the device is fully restored when it is
 * not.
 *
 * `opts.approve` should normally be `() => true`: the rollback is part
 * of the same user-approved operation that just failed.
 */
export async function rollbackSections(
  snapshot: DeviceSnapshot,
  writer: RestoreWriter,
  sections: readonly SnapshotSectionName[],
  opts: TransactionOptions = {},
): Promise<RollbackOutcome> {
  const wanted = SECTION_ORDER.filter((s) => sections.includes(s));
  const present = new Set(
    (Object.keys(snapshot.sections) as SnapshotSectionName[]).filter(
      (s) => snapshot.sections[s] !== undefined,
    ),
  );
  const unavailable: RollbackUnavailable[] = wanted
    .filter((s) => !present.has(s))
    .map((s) => ({
      section: s,
      detail: 'no data captured in the pre-write snapshot',
    }));
  const restorable = wanted.filter((s) => present.has(s));

  const ops = planRestore(snapshot, writer, restorable);
  const tx = await runTransaction(ops, {
    approve: opts.approve,
    audit: opts.audit,
    session: opts.session,
  });
  const results: SectionResult[] = restorable.map((name) =>
    aggregateSection(name, tx.journal, !tx.completed),
  );
  return {
    requested: wanted,
    unavailable,
    sections: results,
    tx,
    rolledBack: results.filter(
      (r) => r.result === 'success' || r.result === 'unverified',
    ).length,
    failed: results.filter((r) => r.result === 'failed').length,
  };
}
