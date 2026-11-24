/**
 * `web/src/agent/` — the agent-first layer (docs/AGENT-ARCHITECTURE.md,
 * bead oh-my-gravastar-ak2). Library only: nothing here is wired into
 * pages yet.
 *
 * Pipeline: device-context → planner → validator → executor, where the
 * executor funnels every write through `safety/transaction.ts` — agents
 * never call HID writes directly.
 *
 *   action-schema.ts   op vocabulary v1 + validateOp/validatePlan
 *   device-context.ts  buildDeviceContext() — "Explain my keyboard" data
 *   planner.ts         planFromOps() — ordering, policy class, diffs
 *   validator.ts       validatePlanAgainstContext() — capability/policy/
 *                      conflict/storage gates
 *   executor.ts        executePlan() — dry-run + transaction execution
 */

export * from './action-schema.ts';
export * from './device-context.ts';
export * from './planner.ts';
export * from './validator.ts';
export * from './executor.ts';
