/**
 * Operation policy — vision-full-custom.md §4 layer 3.
 *
 * Every device-touching action is classified L0–L4 before it runs:
 *
 *   L0 read-only            → automatic (queries, snapshots)
 *   L1 draft/preview        → automatic (local state, no device write)
 *   L2 remap/lighting/macro → approval before write
 *   L3 polling/calibration  → separate confirmation + impact explanation
 *   L4 factory/fw/bootloader→ never permitted (protocol blacklist stays)
 *
 * `classify()` is pure and total: unknown future op types fall through to
 * the strictest class rather than slipping through as reads.
 */

export type OperationClass = 'L0' | 'L1' | 'L2' | 'L3' | 'L4';

export type OpType =
  | 'read'
  | 'draft'
  | 'keymap_write'
  | 'light_write'
  | 'macro_write'
  | 'adv_write'
  | 'profile_restore'
  | 'settings_write'
  | 'polling'
  | 'calibration'
  | 'forbidden';

export interface OpDescriptor {
  type: OpType;
  /** Free-form section label for the journal (e.g. 'keymap', 'lighting'). */
  section?: string;
}

export interface PolicyDecision {
  class: OperationClass;
  /** True when a human must approve before the op may run. */
  requiresApproval: boolean;
  /** False only for L4 — blacklisted ops can never be approved. */
  allowed: boolean;
  reason: string;
}

const DECISIONS: Record<OpType, PolicyDecision> = {
  read: {
    class: 'L0',
    requiresApproval: false,
    allowed: true,
    reason: 'read-only query; safe to run automatically',
  },
  draft: {
    class: 'L1',
    requiresApproval: false,
    allowed: true,
    reason: 'local draft/preview; nothing is sent to the device',
  },
  keymap_write: {
    class: 'L2',
    requiresApproval: true,
    allowed: true,
    reason: 'writes key assignments to the device; needs explicit approval',
  },
  light_write: {
    class: 'L2',
    requiresApproval: true,
    allowed: true,
    reason: 'writes lighting configuration to the device; needs explicit approval',
  },
  macro_write: {
    class: 'L2',
    requiresApproval: true,
    allowed: true,
    reason: 'writes the macro region to the device; needs explicit approval',
  },
  adv_write: {
    class: 'L2',
    requiresApproval: true,
    allowed: true,
    reason: 'writes advanced-key (SOCD/MT/TGL) state; needs explicit approval',
  },
  profile_restore: {
    class: 'L2',
    requiresApproval: true,
    allowed: true,
    reason: 'restores stored device state; needs explicit approval',
  },
  settings_write: {
    class: 'L2',
    requiresApproval: true,
    allowed: true,
    reason: 'writes device settings (profile blob); needs explicit approval',
  },
  polling: {
    class: 'L3',
    requiresApproval: true,
    allowed: true,
    reason:
      'changes the report/polling rate and may restart the device connection; needs a separate confirmation with impact explanation',
  },
  calibration: {
    class: 'L3',
    requiresApproval: true,
    allowed: true,
    reason:
      'starts/stops device calibration; needs a separate confirmation with impact explanation',
  },
  forbidden: {
    class: 'L4',
    requiresApproval: false,
    allowed: false,
    reason:
      'blacklisted operation (factory reset / firmware update / bootloader / protocol-forbidden command) — never permitted',
  },
};

/**
 * Classify one operation. `section` is carried for context but does not
 * change the class — the op *type* is what the policy governs.
 */
export function classify(op: OpDescriptor): PolicyDecision {
  const base = DECISIONS[op.type] ?? DECISIONS.forbidden;
  return { ...base };
}

/** True for op types that mutate device state (need snapshot + journal). */
export function isWriteOp(op: OpDescriptor): boolean {
  return classify(op).class === 'L2' || classify(op).class === 'L3';
}
