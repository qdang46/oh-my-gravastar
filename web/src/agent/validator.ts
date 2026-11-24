/**
 * Plan validator — `docs/AGENT-ARCHITECTURE.md` §4 and SAFETY-SPEC §2–3.
 *
 * `validatePlanAgainstContext()` runs the ordered gates the architecture
 * requires, on top of the schema validation already done by
 * `action-schema.ts` / `planner.ts`:
 *
 *   1. policy gate — L4 → hard error (unplannable), L3 → warning that a
 *      separate confirmation is required;
 *   2. capability gate — every op maps to capability-matrix keys
 *      (`core/capabilities.ts`); `unsupported-*`/`protocol-unknown`/missing
 *      → error with the registry reason; `unverified`/`experimental` →
 *      warning (the caveat rides into the preview, R5);
 *   3. cross-op conflicts — duplicate keymap (layer,system) targets,
 *      macro name/index collisions, adv/macro binds colliding with
 *      keymap writes (warnings — the later write wins);
 *   4. storage limits — macro region free space from the device context,
 *      snapshot id/section existence.
 *
 * Output: `{ ok, errors[], warnings[] }` — `ok:false` means the executor
 * must refuse the plan.
 */

import type { CapabilityKey, CapabilityMap } from '../core/capabilities.ts';
import { classify } from '../safety/policy.ts';
import { MACRO_REGION_BYTES, macroSpaceNeeded } from '../proto/macro916.ts';
import { AGENT_OP_KINDS, type AgentOp, type AgentOpKind } from './action-schema.ts';
import { policyDescriptor, type AgentPlan, type AgentPlanOp } from './planner.ts';
import type { DeviceContext } from './device-context.ts';

export interface PlanValidation {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

const KNOWN_OPS: ReadonlySet<string> = new Set(AGENT_OP_KINDS);

// ── Op → capability keys ───────────────────────────────────────────────

const LIGHT_PER_KEY_FIELDS: ReadonlySet<string> = new Set(['colors', 'entries']);

function opCapabilities(op: AgentOp): CapabilityKey[] {
  switch (op.op) {
    case 'set_keymap':
      return ['keymap'];
    case 'set_light': {
      const keys =
        typeof op.config === 'object' && op.config !== null
          ? (op.config as Record<string, unknown>).keys
          : undefined;
      const perKey =
        typeof keys === 'object' &&
        keys !== null &&
        Object.keys(keys).some((k) => LIGHT_PER_KEY_FIELDS.has(k));
      return perKey ? ['lighting_effects', 'per_key_rgb'] : ['lighting_effects'];
    }
    case 'set_macro':
      return ['macro'];
    case 'set_adv':
      return ['adv_keys'];
    case 'set_profile_section':
      // Profile-blob fields (sleep time) ride the base khub916 config
      // write — no dedicated matrix key; policy still gates them L2.
      return [];
    case 'restore_snapshot':
      return (op.sections ?? ['keymap', 'lighting', 'macro', 'profile']).flatMap((s) => {
        if (s === 'keymap') return ['keymap' as CapabilityKey];
        if (s === 'lighting') return ['lighting_effects' as CapabilityKey];
        if (s === 'macro') return ['macro' as CapabilityKey];
        return [];
      });
    default:
      return [];
  }
}

const CAP_BLOCKED: ReadonlySet<string> = new Set([
  'unsupported-hardware',
  'unsupported-firmware',
  'protocol-unknown',
]);

function capabilityGate(
  pop: AgentPlanOp,
  caps: CapabilityMap,
  errors: string[],
  warnings: string[],
): void {
  const where = `op '${pop.op.op}'${pop.op.id ? ` (${pop.op.id})` : ''}`;
  for (const key of opCapabilities(pop.op)) {
    const cap = caps[key];
    if (!cap) {
      errors.push(`${where}: capability '${key}' not reported for this device`);
      continue;
    }
    if (CAP_BLOCKED.has(cap.state)) {
      errors.push(`${where}: '${key}' is ${cap.state}${cap.reason ? ` — ${cap.reason}` : ''}`);
    } else if (cap.state === 'unverified' || cap.state === 'experimental') {
      warnings.push(
        `${where}: '${key}' is ${cap.state}${cap.reason ? ` — ${cap.reason}` : ''}; the result may be unconfirmed`,
      );
    }
  }
}

// ── Conflict detection ─────────────────────────────────────────────────

function conflictChecks(
  plan: AgentPlan,
  errors: string[],
  warnings: string[],
): void {
  const keymapTargets = new Map<string, { count: number }>();
  /** arg0 (layer 0, system 0) slot writes — for bind collisions. */
  const arg0Writes = new Map<number, string>();
  const macroNames = new Map<string, string>();
  const macroIndices = new Map<number, string>();
  let restoreCount = 0;
  let writeCount = 0;

  const claimArg0 = (index: number, who: string): void => {
    const prev = arg0Writes.get(index);
    if (prev && prev !== who) {
      warnings.push(
        `key ${index} is written by both ${prev} and ${who} — the later write wins; reorder or merge the ops`,
      );
    }
    arg0Writes.set(index, who);
  };

  for (const pop of plan.ops) {
    const op = pop.op;
    const who = `op '${op.id ?? op.op}'`;
    switch (op.op) {
      case 'set_keymap': {
        writeCount++;
        const layer = op.layer;
        const system = op.system ?? 0;
        const target = `${layer}:${system}`;
        const cur = keymapTargets.get(target) ?? { count: 0 };
        cur.count++;
        for (const e of op.entries) {
          if (layer === 0 && system === 0) claimArg0(e.index, who);
        }
        keymapTargets.set(target, cur);
        break;
      }
      case 'set_macro': {
        writeCount++;
        if (op.name !== undefined) {
          const key = op.name.toLowerCase();
          const prev = macroNames.get(key);
          if (prev) {
            errors.push(
              `set_macro name '${op.name}' is targeted by both ${prev} and ${who} — merge or rename`,
            );
          } else {
            macroNames.set(key, who);
          }
        }
        if (op.index !== undefined && !op.delete) {
          const prev = macroIndices.get(op.index);
          if (prev) {
            errors.push(`set_macro index ${op.index} is targeted by both ${prev} and ${who}`);
          } else {
            macroIndices.set(op.index, who);
          }
        }
        if (op.bind_key !== undefined && (op.bind_layer ?? 0) === 0) {
          claimArg0(op.bind_key, `${who} (macro bind)`);
        }
        break;
      }
      case 'set_adv': {
        writeCount++;
        // adv writes the arg-0 keymap slot(s) it binds; tgl's `toggle`
        // is only READ (its current value is stored in history).
        const written = op.mode === 'socd' ? [op.key_a, op.key_b] : [op.key];
        for (const k of written) {
          if (typeof k === 'number') claimArg0(k, `${who} (adv ${op.mode})`);
        }
        break;
      }
      case 'set_light':
      case 'set_profile_section':
        writeCount++;
        break;
      case 'restore_snapshot':
        restoreCount++;
        break;
    }
  }

  for (const [target, t] of keymapTargets) {
    if (t.count > 1) {
      errors.push(
        `${t.count} set_keymap ops target layer/system ${target} — merge them into one op (writes are whole-table; last would silently win)`,
      );
    }
  }

  if (restoreCount > 0 && writeCount > 0) {
    warnings.push(
      'restore_snapshot runs last — earlier write ops in this plan will be overwritten by the restore',
    );
  }
}

// ── Storage limits ─────────────────────────────────────────────────────

function macroStepCount(op: Extract<AgentOp, { op: 'set_macro' }>): number {
  if (Array.isArray(op.steps)) return op.steps.length;
  if (
    typeof op.steps === 'object' &&
    op.steps !== null &&
    Array.isArray((op.steps as { steps?: unknown }).steps)
  ) {
    return ((op.steps as { steps: unknown[] }).steps).length;
  }
  return 0;
}

function macroStorageCheck(
  pop: AgentPlanOp,
  context: DeviceContext,
  errors: string[],
): void {
  const op = pop.op;
  if (op.op !== 'set_macro' || op.delete) return;

  const steps = macroStepCount(op);
  const name = op.name ?? '';
  const needed = macroSpaceNeeded(name, steps);

  if (needed > MACRO_REGION_BYTES) {
    errors.push(
      `set_macro '${name}': needs ~${needed} region bytes — over the ${MACRO_REGION_BYTES}-byte cap`,
    );
    return;
  }

  const free = context.state.macroFreeBytes;
  if (free === undefined) return; // no live region read — schema caps applied

  // Replacing an existing macro frees its current body (1 + name + 4·steps).
  let credit = 0;
  const existing = name ? context.macros.find((m) => m.name === name) : undefined;
  if (existing) {
    credit = 1 + new TextEncoder().encode(existing.name).length + existing.steps * 4;
  }
  if (needed > free + credit) {
    errors.push(
      `set_macro '${name}': needs ~${needed} bytes but only ~${free + credit} are free in the macro region — delete unused macros first`,
    );
  }
}

// ── Snapshot checks ────────────────────────────────────────────────────

function snapshotChecks(
  pop: AgentPlanOp,
  context: DeviceContext,
  errors: string[],
): void {
  const op = pop.op;
  if (op.op !== 'restore_snapshot') return;
  const snaps = context.snapshots;
  if (!snaps) return; // no store supplied — executor fails honestly if missing
  const meta = snaps.find((s) => s.id === op.id);
  if (!meta) {
    errors.push(`restore_snapshot: no snapshot '${op.id}' in the store (pruned or unknown)`);
    return;
  }
  for (const s of op.sections ?? []) {
    if (!meta.sections.includes(s)) {
      errors.push(`restore_snapshot: snapshot '${op.id}' has no '${s}' section`);
    }
  }
}

// ── Public API ─────────────────────────────────────────────────────────

/**
 * Run every context-aware gate over a plan. `plan.valid` and
 * `plan.errors` (schema level) are honoured first — a schema-broken plan
 * fails without further checks.
 */
export function validatePlanAgainstContext(
  plan: AgentPlan,
  context: DeviceContext,
): PlanValidation {
  const errors: string[] = [];
  const warnings: string[] = [...plan.warnings];

  if (!plan.valid) {
    return { ok: false, errors: [...plan.errors], warnings };
  }

  for (const pop of plan.ops) {
    // Defensive: forged/unknown op kinds can never reach execution.
    if (!KNOWN_OPS.has(pop.op.op)) {
      errors.push(`op '${String((pop.op as AgentOp).op)}': unknown op kind — refused`);
      continue;
    }
    // Re-derive the class from the op kind — plan-supplied policy labels
    // are display data, not a trust boundary.
    const decision = classify(policyDescriptor(pop.op));
    if (!decision.allowed || decision.class === 'L4') {
      errors.push(
        `op '${pop.op.op}': refused by policy (L4) — ${decision.reason}`,
      );
      continue;
    }
    if (decision.class === 'L3') {
      warnings.push(
        `op '${pop.op.op}': L3 disruptive write — needs a separate confirmation with impact explanation`,
      );
    }
    capabilityGate(pop, context.capabilities, errors, warnings);
    snapshotChecks(pop, context, errors);
    macroStorageCheck(pop, context, errors);
  }

  conflictChecks(plan, errors, warnings);

  return { ok: errors.length === 0, errors, warnings };
}
