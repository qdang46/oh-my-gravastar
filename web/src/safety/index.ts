/**
 * web/src/safety — the Phase-0 safety layer (vision-full-custom.md §4).
 *
 * Library only: nothing here is wired into pages yet. Layers:
 *   validation.ts   L1 input validation (schema/range/size, never throws)
 *   policy.ts       L3 operation classes L0–L4
 *   snapshots.ts    L5 pre-write restore points (localStorage)
 *   transaction.ts  L4 transaction executor + dry-run + journal
 *   rollback.ts     L5 restore a snapshot through verified write APIs
 *   audit-log.ts    L5 append-only activity log (ring buffer)
 */

export * from './validation.ts';
export * from './policy.ts';
export * from './snapshots.ts';
export * from './transaction.ts';
export * from './rollback.ts';
export * from './audit-log.ts';
