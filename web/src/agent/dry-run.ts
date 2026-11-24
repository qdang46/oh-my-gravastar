/**
 * Dry-run write report — `docs/AGENT-ARCHITECTURE.md` §4/§6 and bead
 * oh-my-gravastar-fw6.
 *
 * `buildDryRunReport()` turns a plan into a structured preview the UI
 * (or an agent) can render BEFORE approval: per-op predicted device
 * writes — which session method would be invoked, the keymap arg/slot
 * or section it touches, and byte counts where they are deterministic.
 *
 * The predictions MIRROR `executor.ts` lowering statically — they never
 * invoke `apply`, never touch a session, and stay pure/DOM-free. They
 * are estimates: read-modify-write lengths depend on the live device
 * read, so `bytes` is only set when the size is fixed by the protocol
 * (adv blob 512 B, custom colours 126×3 B, macro region estimate).
 *
 *   buildDryRunReport(plan, { context, snapshots })
 *     → { planId, deviceSelector, validation, ops[], totals }
 */

import {
  CUSTOM_LIGHT_SLOTS,
  LIGHT_DATA_MAX,
} from '../proto/light.ts';
import {
  MACRO_REGION_BYTES,
  macroSpaceNeeded,
} from '../proto/macro916.ts';
import { ADV_BLOB_BYTES } from '../proto/advkey916.ts';
import { KEYMAP_ENTRIES } from '../proto/khub916.ts';
import type { OperationClass } from '../safety/policy.ts';
import type { SnapshotStore, SnapshotSectionName } from '../safety/snapshots.ts';
import type { AgentOp, AgentOpKind } from './action-schema.ts';
import type { AgentPlan, AgentPlanOp } from './planner.ts';
import { validatePlanAgainstContext, type PlanValidation } from './validator.ts';
import type { DeviceContext } from './device-context.ts';

// ── Report shape ───────────────────────────────────────────────────────

/** One predicted device write inside a plan op. */
export interface PredictedWrite {
  /**
   * Session method that would be invoked — an `AgentSession` /
   * `RestoreWriter` write method name (hid.ts implements them all).
   */
  method: string;
  /** Section label for grouping (keymap / lighting / macro / advkeys / profile). */
  section: string;
  /** Human/agent-readable detail (slot, arg, counts). */
  detail: string;
  /**
   * Predicted payload size in bytes — only when fixed by the protocol.
   * Read-modify-write lengths that depend on the live read are omitted.
   */
  bytes?: number;
  /** Packed keymap arg (layer | system<<2) for keymap-channel writes. */
  arg?: number;
}

/** All predicted writes for one plan op. */
export interface OpWritePreview {
  /** Position in `plan.ops` (execution order). */
  index: number;
  op: AgentOpKind;
  id?: string;
  /** The planner's diff line for this op. */
  diff: string;
  /** Policy class at plan time. */
  policyClass: OperationClass;
  writes: PredictedWrite[];
}

export interface DryRunReport {
  schema_version: 1;
  planId: string;
  deviceSelector: string;
  /** Context-aware validation result (same gate the executor runs). */
  validation: PlanValidation;
  /** Per-op predicted writes, in execution order. */
  ops: OpWritePreview[];
  totals: {
    ops: number;
    /** Total predicted device writes across all ops. */
    writes: number;
    /** Sum of deterministic byte counts (lower bound — RMW sizes vary). */
    bytes?: number;
  };
}

// ── Per-op prediction ──────────────────────────────────────────────────

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function keymapArg(layer: number, system: number): number {
  return (layer & 3) | ((system & 1) << 2);
}

function macroStepTotal(op: Extract<AgentOp, { op: 'set_macro' }>): number {
  if (Array.isArray(op.steps)) return op.steps.length;
  if (isRecord(op.steps) && Array.isArray(op.steps.steps)) return op.steps.steps.length;
  return 0;
}

function predictSetKeymap(pop: AgentPlanOp): PredictedWrite[] {
  const op = pop.op as Extract<AgentOp, { op: 'set_keymap' }>;
  const system = op.system ?? 0;
  const arg = keymapArg(op.layer, system);
  const idx = op.entries.map((e) => e.index);
  const range =
    idx.length === 1
      ? `slot ${idx[0]}`
      : `slots ${Math.min(...idx)}..${Math.max(...idx)} (${idx.length} patched)`;
  return [
    {
      method: 'writeKeymap',
      section: 'keymap',
      arg,
      detail: `layer ${op.layer} system ${system} (arg ${arg}): patch ${range} of the ${KEYMAP_ENTRIES}-slot u32 table (read-modify-write)`,
    },
  ];
}

function predictSetLight(pop: AgentPlanOp): PredictedWrite[] {
  const op = pop.op as Extract<AgentOp, { op: 'set_light' }>;
  const cfg = isRecord(op.config) ? op.config : {};
  const keys = isRecord(cfg.keys) ? cfg.keys : {};
  const out: PredictedWrite[] = [];

  if (
    cfg.mode !== undefined ||
    cfg.speed !== undefined ||
    cfg.brightness !== undefined ||
    cfg.color_model !== undefined
  ) {
    out.push({
      method: 'writeProfile',
      section: 'lighting',
      detail: `profile blob: mode=${String(cfg.mode ?? 'keep')} speed=${String(cfg.speed ?? 'keep')} brightness=${String(cfg.brightness ?? 'keep')} color_model=${String(cfg.color_model ?? 'keep')}`,
      bytes: 512, // FEATURE_PAYLOAD_BYTES cap — actual blob is device-sized
    });
  }
  if (cfg.color !== undefined || keys.color !== undefined) {
    out.push({
      method: 'writeLightData',
      section: 'lighting',
      detail: `light-data blob: group colour for mode ${String(cfg.mode ?? 'current')}`,
      bytes: LIGHT_DATA_MAX,
    });
  }
  if (Array.isArray(keys.colors)) {
    out.push({
      method: 'writeCustomLightColors',
      section: 'lighting',
      detail: `custom colour table: all ${CUSTOM_LIGHT_SLOTS} slots`,
      bytes: CUSTOM_LIGHT_SLOTS * 3,
    });
  }
  if (Array.isArray(keys.entries) && keys.entries.length > 0) {
    out.push({
      method: 'writeCustomLightColors',
      section: 'lighting',
      detail: `custom colour table: ${keys.entries.length} slot(s) patched (read-modify-write of ${CUSTOM_LIGHT_SLOTS})`,
      bytes: CUSTOM_LIGHT_SLOTS * 3,
    });
  }
  return out;
}

function predictSetMacro(pop: AgentPlanOp): PredictedWrite[] {
  const op = pop.op as Extract<AgentOp, { op: 'set_macro' }>;
  const out: PredictedWrite[] = [];
  if (op.delete) {
    out.push({
      method: 'writeMacroRegion',
      section: 'macro',
      detail: `macro region: delete '${op.name ?? `#${op.index}`}' (rewrite of ≤${MACRO_REGION_BYTES} B)`,
      bytes: MACRO_REGION_BYTES,
    });
  } else {
    const steps = macroStepTotal(op);
    out.push({
      method: 'writeMacroRegion',
      section: 'macro',
      detail: `macro region: write '${op.name ?? `#${op.index}`}' (${steps} step(s), ~${macroSpaceNeeded(op.name ?? '', steps)} B of ${MACRO_REGION_BYTES})`,
      bytes: macroSpaceNeeded(op.name ?? '', steps),
    });
    if (op.bind_key !== undefined) {
      out.push({
        method: 'writeKeymap',
        section: 'keymap',
        arg: (op.bind_layer ?? 0) & 3,
        detail: `bind macro to arg ${(op.bind_layer ?? 0) & 3} slot ${op.bind_key} (tag-3 value, read-modify-write)`,
      });
    }
  }
  return out;
}

function predictSetAdv(pop: AgentPlanOp): PredictedWrite[] {
  const op = pop.op as Extract<AgentOp, { op: 'set_adv' }>;
  const keys =
    op.mode === 'socd'
      ? [op.key_a, op.key_b].filter((k): k is number | string => k !== undefined)
      : [op.key].filter((k): k is number | string => k !== undefined);
  return [
    {
      method: 'writeKeyConfiguration',
      section: 'advkeys',
      arg: 0,
      detail: `arg-0 key-configuration channel: ${op.mode.toUpperCase()} bind on ${keys.map(String).join('/')}`,
    },
    {
      method: 'writeAdvKeyConfig',
      section: 'advkeys',
      detail: `adv-key history blob (${ADV_BLOB_BYTES} B, vendor order: keymap first, then blob)`,
      bytes: ADV_BLOB_BYTES,
    },
  ];
}

const SNAPSHOT_SECTION_WRITES: Record<
  SnapshotSectionName,
  { method: string; detail: string; bytes?: number }[]
> = {
  keymap: [
    {
      method: 'writeKeymap',
      detail: 'keymap: one writeKeymap per stored keymap set (args 0–7)',
    },
  ],
  lighting: [
    { method: 'writeLightData', detail: 'lighting: light-data blob', bytes: LIGHT_DATA_MAX },
    {
      method: 'writeCustomLightColors',
      detail: `lighting: per-key colours (${CUSTOM_LIGHT_SLOTS} slots)`,
      bytes: CUSTOM_LIGHT_SLOTS * 3,
    },
  ],
  macro: [
    { method: 'writeMacroRegion', detail: 'macro: whole macro region', bytes: MACRO_REGION_BYTES },
  ],
  profile: [
    { method: 'writeProfile', detail: 'profile: whole profile blob', bytes: 512 },
  ],
};

function predictRestoreSnapshot(
  pop: AgentPlanOp,
  snapshots: SnapshotStore | undefined,
): PredictedWrite[] {
  const op = pop.op as Extract<AgentOp, { op: 'restore_snapshot' }>;
  const sections = op.sections ?? ['keymap', 'lighting', 'macro', 'profile'];
  const snap = snapshots?.get(op.id) ?? null;
  const out: PredictedWrite[] = [];

  for (const s of sections) {
    if (s === 'keymap' && snap?.sections.keymap) {
      // planRestore emits one writeKeymap per stored arg — an empty
      // record produces zero writes.
      const args = Object.keys(snap.sections.keymap);
      if (args.length === 0) continue;
      out.push({
        method: 'writeKeymap',
        section: 'keymap',
        detail: `keymap: restore ${args.length} stored keymap set(s) (${args.join(',')})`,
      });
      continue;
    }
    if (s === 'lighting' && snap?.sections.lighting) {
      const light = snap.sections.lighting;
      if (light.lightData !== undefined) {
        out.push({
          method: 'writeLightData',
          section: 'lighting',
          detail: 'lighting: stored light-data blob',
          bytes: LIGHT_DATA_MAX,
        });
      }
      if (light.colors !== undefined) {
        out.push({
          method: 'writeCustomLightColors',
          section: 'lighting',
          detail: `lighting: stored per-key colours (${light.colors.length} slots)`,
          bytes: CUSTOM_LIGHT_SLOTS * 3,
        });
      }
      // planRestore emits nothing when the lighting section has neither
      // blob — an empty capture produces zero writes, not a placeholder.
      continue;
    }
    if (s === 'macro' && snap?.sections.macro !== undefined) {
      out.push({
        method: 'writeMacroRegion',
        section: 'macro',
        detail: 'macro: stored macro region',
        bytes: MACRO_REGION_BYTES,
      });
      continue;
    }
    if (s === 'profile' && snap?.sections.profile !== undefined) {
      out.push({
        method: 'writeProfile',
        section: 'profile',
        detail: 'profile: stored profile blob',
        bytes: 512,
      });
      continue;
    }
    // Snapshot data unavailable for this section: either no store was
    // supplied, the snapshot is gone, or the section wasn't captured.
    // Report the generic per-section write honestly.
    const why = snap === null ? 'contents unknown — no store supplied' : 'section absent from snapshot';
    for (const w of SNAPSHOT_SECTION_WRITES[s]) {
      out.push({
        method: w.method,
        section: s,
        detail: `snapshot '${op.id}' ${w.detail} (${why})`,
        ...(w.bytes !== undefined ? { bytes: w.bytes } : {}),
      });
    }
  }
  return out;
}

function predictSetProfileSection(pop: AgentPlanOp): PredictedWrite[] {
  const op = pop.op as Extract<AgentOp, { op: 'set_profile_section' }>;
  return [
    {
      method: 'writeProfile',
      section: 'profile',
      detail: `profile blob: ${op.section} = ${op.value} (read-modify-write)`,
      bytes: 512,
    },
  ];
}

function predictWrites(
  pop: AgentPlanOp,
  snapshots: SnapshotStore | undefined,
): PredictedWrite[] {
  switch (pop.op.op) {
    case 'set_keymap':
      return predictSetKeymap(pop);
    case 'set_light':
      return predictSetLight(pop);
    case 'set_macro':
      return predictSetMacro(pop);
    case 'set_adv':
      return predictSetAdv(pop);
    case 'restore_snapshot':
      return predictRestoreSnapshot(pop, snapshots);
    case 'set_profile_section':
      return predictSetProfileSection(pop);
    default:
      return [];
  }
}

// ── Public API ─────────────────────────────────────────────────────────

export interface DryRunOptions {
  /**
   * Device context for the validator — strongly recommended; without it
   * only schema-level plan errors are reported.
   */
  context?: DeviceContext;
  /** SnapshotStore — lets restore predictions enumerate real sections. */
  snapshots?: SnapshotStore;
}

/**
 * Build the dry-run report for a plan: validation verdict plus the
 * predicted write list per op. Pure — safe to call before approval,
 * in the UI preview, or from an agent checking "what would this do?".
 *
 * `report.ok` mirrors `validation.ok` — false means the executor would
 * refuse the plan.
 */
export function buildDryRunReport(
  plan: AgentPlan,
  opts: DryRunOptions = {},
): DryRunReport & { ok: boolean } {
  const validation: PlanValidation = opts.context
    ? validatePlanAgainstContext(plan, opts.context)
    : plan.valid
      ? { ok: true, errors: [], warnings: plan.warnings }
      : { ok: false, errors: [...plan.errors], warnings: plan.warnings };

  const ops: OpWritePreview[] = plan.ops.map((pop, index) => ({
    index,
    op: pop.op.op,
    ...(pop.op.id !== undefined ? { id: pop.op.id } : {}),
    diff: pop.diff,
    policyClass: pop.policy.class,
    writes: predictWrites(pop, opts.snapshots),
  }));

  const writes = ops.reduce((n, o) => n + o.writes.length, 0);
  const sized = ops.flatMap((o) => o.writes).filter((w) => w.bytes !== undefined);
  const bytes = sized.length > 0 ? sized.reduce((n, w) => n + (w.bytes ?? 0), 0) : undefined;

  return {
    schema_version: 1,
    planId: plan.plan_id,
    deviceSelector: plan.device_selector,
    validation,
    ops,
    totals: { ops: ops.length, writes, ...(bytes !== undefined ? { bytes } : {}) },
    ok: validation.ok,
  };
}
