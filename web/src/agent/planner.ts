/**
 * Planner — `docs/AGENT-ARCHITECTURE.md` §4.
 *
 * `planFromOps()` turns a validated op list into an ordered `AgentPlan`:
 *
 *   1. per-op schema validation (`action-schema.ts`) — invalid ops land
 *      in `errors[]`, never in the plan;
 *   2. device-specific resolution — keymap slot indices or layout key
 *      names → slot indices (`DeviceContext.layout`);
 *   3. safe ordering — reads first (none in v1), writes grouped by
 *      section, `restore_snapshot` ALWAYS last so a restore can't be
 *      overwritten by an earlier write it was meant to undo;
 *   4. per-op policy class via `safety/policy.ts` + a human/agent-readable
 *      diff line (the same shape the UI preview modal renders).
 *
 * The planner never invents ops and never drops policy: L4 is impossible
 * here by construction (the op vocabulary has no L4 kind) and the
 * validator re-checks everything before execution.
 */

import { classify, type OpType, type PolicyDecision } from '../safety/policy.ts';
import { validateOp, type AgentOp, type AgentOpKind } from './action-schema.ts';
import type { DeviceContext } from './device-context.ts';
import { keyIndexOf, type KeyBlock } from '../k1pro-layout.ts';

// ── Plan shape ─────────────────────────────────────────────────────────

/** Policy + ordering metadata attached to one validated op. */
export interface AgentPlanOp {
  /** The validated, normalised op (schema v1). */
  op: AgentOp;
  /** Section label for journal/diff grouping. */
  section: string;
  /** Policy decision at plan time (classify() is pure — re-checked at exec). */
  policy: PolicyDecision;
  /** One-line human/agent-readable diff ("keymap L0: 2 slot(s)"). */
  diff: string;
}

export interface AgentPlan {
  schema_version: 1;
  plan_id: string;
  /** Common device selector, or 'mixed' when ops disagree. */
  device_selector: string;
  /**
   * Unique `device_selector`s across ops, first-seen order. This is the
   * multi-device intent the schema carries: each op keeps its own
   * selector (`AgentOp.device_selector`), which maps 1:1 onto the
   * `device` field of a step in the `omg plan` JSON format
   * (docs/plan-json.md). Execution is still single-session — see
   * docs/agent-api.md §8.
   */
  device_selectors: string[];
  ops: AgentPlanOp[];
  /** Same strings as `ops[].diff`, in execution order. */
  diffSummary: string[];
  warnings: string[];
  /** Schema/validation errors — non-empty means the plan must not run. */
  errors: string[];
  valid: boolean;
  /** True when any op needs approval (L2/L3). */
  requiresApproval: boolean;
}

// ── Op → policy mapping ────────────────────────────────────────────────

interface OpMeta {
  type: OpType;
  section: string;
  /** Execution-order group; restore_snapshot is forced last. */
  order: number;
}

const OP_META: Record<AgentOpKind, OpMeta> = {
  set_keymap: { type: 'keymap_write', section: 'keymap', order: 0 },
  set_light: { type: 'light_write', section: 'lighting', order: 1 },
  set_macro: { type: 'macro_write', section: 'macro', order: 2 },
  set_adv: { type: 'adv_write', section: 'advkeys', order: 3 },
  set_profile_section: { type: 'settings_write', section: 'profile', order: 4 },
  restore_snapshot: { type: 'profile_restore', section: 'snapshot', order: 5 },
};

/**
 * Policy descriptor for an op — the validator re-derives the class from
 * the op KIND (never trusts a plan-supplied label), so a forged
 * `policy.class` cannot smuggle an L4 op past the gate.
 */
export function policyDescriptor(op: AgentOp): { type: OpType; section: string } {
  const meta = OP_META[op.op];
  return { type: meta.type, section: meta.section };
}

// ── Key-name resolution ────────────────────────────────────────────────

/**
 * Resolve a `number | string` key reference to a keymap slot index.
 * Strings match a layout block `name` (vendor labels like "Caps",
 * "L_Ctrl", "W") case-insensitively; `pos` domain → index via
 * `keyIndexOf`. Returns null when unresolvable.
 */
export function resolveKeyRef(
  ref: number | string,
  layout: readonly KeyBlock[] | undefined,
): number | null {
  if (typeof ref === 'number') return ref;
  const blocks = layout ?? [];
  const want = ref.trim().toLowerCase();
  for (const b of blocks) {
    if (b.display && b.name.toLowerCase() === want) {
      return keyIndexOf(b.pos);
    }
  }
  return null;
}

function resolveAdvKeys(op: AgentOp, context: DeviceContext | undefined, errors: string[]): AgentOp {
  if (op.op !== 'set_adv') return op;
  const layout = context?.layout;
  const resolve = (v: number | string | undefined, what: string): number | string | undefined => {
    if (v === undefined) return undefined;
    if (typeof v === 'number') return v;
    const idx = resolveKeyRef(v, layout);
    if (idx === null) {
      errors.push(`ops: set_adv ${what} '${v}' does not match a key on the device layout`);
      return v; // keep the string; validator/executor will refuse it
    }
    return idx;
  };
  return {
    ...op,
    ...(op.key !== undefined ? { key: resolve(op.key, 'key') ?? op.key } : {}),
    ...(op.key_a !== undefined ? { key_a: resolve(op.key_a, 'key_a') ?? op.key_a } : {}),
    ...(op.key_b !== undefined ? { key_b: resolve(op.key_b, 'key_b') ?? op.key_b } : {}),
    ...(op.toggle !== undefined ? { toggle: resolve(op.toggle, 'toggle') ?? op.toggle } : {}),
  };
}

// ── Diff lines ─────────────────────────────────────────────────────────

function diffFor(op: AgentOp): string {
  switch (op.op) {
    case 'set_keymap': {
      const idx = op.entries.map((e) => e.index);
      const range = idx.length === 1 ? `slot ${idx[0]}` : `${idx.length} slots`;
      return `keymap layer ${op.layer} system ${op.system ?? 0}: set ${range}`;
    }
    case 'set_light': {
      const c = op.config;
      const fields = isRecord(c)
        ? ['mode', 'speed', 'brightness', 'color_model', 'color', 'keys']
            .filter((k) => c[k] !== undefined)
            .join(', ')
        : 'config';
      return `lighting: ${fields || 'config'}`;
    }
    case 'set_macro': {
      if (op.delete) return `macro ${op.name ?? `#${op.index}`}: delete`;
      const steps = Array.isArray(op.steps)
        ? op.steps.length
        : isRecord(op.steps) && Array.isArray(op.steps.steps)
          ? op.steps.steps.length
          : 0;
      return `macro '${op.name ?? `#${op.index}`}': ${steps} step(s)${op.bind_key !== undefined ? ` + bind key ${op.bind_key}` : ''}`;
    }
    case 'set_adv': {
      if (op.mode === 'mt') return `adv MT on key ${String(op.key)}: tap=${String(op.tap)} hold=${String(op.hold)}`;
      if (op.mode === 'socd') return `adv SOCD keys ${String(op.key_a)}/${String(op.key_b)} dir ${op.direction ?? 0}`;
      return `adv TGL on key ${String(op.key)} → ${String(op.toggle)}`;
    }
    case 'restore_snapshot': {
      const secs = op.sections?.length ? op.sections.join(',') : 'all sections';
      return `restore snapshot ${op.id} (${secs})`;
    }
    case 'set_profile_section':
      return `profile ${op.section} = ${op.value}`;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// ── Public API ─────────────────────────────────────────────────────────

function newPlanId(): string {
  return `plan-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Build a plan from raw ops. `context` is optional but strongly
 * recommended: without a layout, string key names in `set_adv` cannot be
 * resolved and land in `errors`.
 *
 * Ordering is stable within a section; `restore_snapshot` ops always
 * sort last regardless of input position.
 */
export function planFromOps(
  ops: readonly unknown[],
  context?: DeviceContext,
): AgentPlan {
  const errors: string[] = [];
  const warnings: string[] = [];
  const planned: { op: AgentOp; meta: OpMeta; seq: number }[] = [];

  ops.forEach((raw, i) => {
    const v = validateOp(raw);
    for (const e of v.errors) errors.push(`ops[${i}]: ${e}`);
    if (!v.op) return;
    const resolved = resolveAdvKeys(v.op, context, errors);
    const meta = OP_META[resolved.op];
    planned.push({ op: resolved, meta, seq: i });
  });

  // Mixed device selectors → warn; never guess which device was meant.
  // The per-op selectors are preserved verbatim (`device_selectors`
  // below) so a consumer can split the plan per device or lower it to
  // the `omg plan` per-step `device` field — the executor itself still
  // runs against ONE session.
  const selectors = new Set(planned.map((p) => p.op.device_selector));
  const device_selectors = [...selectors];
  const device_selector =
    selectors.size === 1 ? ([...selectors][0] as string) : selectors.size === 0 ? 'auto' : 'mixed';
  if (selectors.size > 1) {
    warnings.push(
      'ops target different devices (device_selector) — the executor runs against ONE session; split the plan per device',
    );
  }

  // Stable sort by section order; restore_snapshot is order 5 = last.
  planned.sort((a, b) => a.meta.order - b.meta.order || a.seq - b.seq);

  const planOps: AgentPlanOp[] = planned.map((p) => ({
    op: p.op,
    section: p.meta.section,
    policy: classify({ type: p.meta.type, section: p.meta.section }),
    diff: diffFor(p.op),
  }));

  return {
    schema_version: 1,
    plan_id: newPlanId(),
    device_selector,
    device_selectors,
    ops: planOps,
    diffSummary: planOps.map((p) => p.diff),
    warnings,
    errors,
    valid: errors.length === 0 && planOps.length > 0,
    requiresApproval: planOps.some((p) => p.policy.requiresApproval),
  };
}
