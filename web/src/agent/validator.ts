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
 *      keymap writes on the same (arg, slot), duplicate light-mode or
 *      profile-section writes, adv ops sharing the history blob,
 *      restore_snapshot ordering (must be last, overlapping sections
 *      warn) — duplicates on whole-table targets are errors (last-wins
 *      would be silent), slot-level collisions are warnings;
 *   4. op interactions — set_light mode vs per-key colours / group
 *      colour slot / special-mode fields (proto/light.ts tables);
 *   5. storage limits — per-op AND aggregate macro region free space,
 *      snapshot id/section existence;
 *   6. plan friction — oversized plans (> WRITE_FRICTION_OPS ops) get a
 *      warning so the UI can ask for a second look. There are no L3 ops
 *      in schema v1 (polling/calibration are not agent ops yet); when
 *      they land they slot into the per-op L3 warning already emitted.
 *
 * Output: `{ ok, errors[], warnings[] }` — `ok:false` means the executor
 * must refuse the plan.
 */

import type { CapabilityKey, CapabilityMap } from '../core/capabilities.ts';
import {
  COLOR_SUPPORT,
  LIGHT_DATA_MAX,
  LIGHT_GROUP_COLOR_LEN,
  LIGHT_GROUP_STRIDE,
  LIGHT_SPECIAL_MODES,
  lightModeInfo,
} from '../proto/light.ts';
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

/**
 * Plans larger than this get a friction warning — each op is at least
 * one device write, and large change sets deserve a second look before
 * approval. Not an error: legitimate bulk remaps exist.
 */
export const WRITE_FRICTION_OPS = 8;

/** Packed keymap arg for a (layer, system) pair — same packing as the wire. */
function keymapArgOf(layer: number, system: number): number {
  return (layer & 3) | ((system & 1) << 2);
}

function conflictChecks(
  plan: AgentPlan,
  context: DeviceContext,
  errors: string[],
  warnings: string[],
): void {
  const keymapTargets = new Map<string, { count: number }>();
  /**
   * Slot writes keyed by `${arg}:${index}` — arg is the packed
   * layer|system<<2 channel. set_keymap writes its (layer,system) table;
   * set_macro binds write arg = bind_layer (system 0); set_adv writes the
   * vendor arg-0 key-configuration channel. Cross-kind collisions warn
   * (the later write wins) — same as the old arg-0-only check, now
   * covering every channel.
   */
  const slotWriters = new Map<string, { who: string; uid: number }>();
  const macroNames = new Map<string, string>();
  const macroIndices = new Map<number, string>();
  const lightModeSetters: string[] = [];
  const profileSections = new Map<string, string>();
  const advKeys = new Map<number, { who: string; uid: number }>();
  let advOps = 0;
  let restoreCount = 0;
  let writeCount = 0;
  let firstRestoreAt = -1;

  const claimSlot = (arg: number, index: number, who: string, uid: number): void => {
    const key = `${arg}:${index}`;
    const prev = slotWriters.get(key);
    if (prev && prev.uid !== uid) {
      warnings.push(
        `keymap arg ${arg} slot ${index} is written by both ${prev.who} and ${who} — the later write wins; reorder or merge the ops`,
      );
    }
    slotWriters.set(key, { who, uid });
  };

  plan.ops.forEach((pop, i) => {
    const op = pop.op;
    // #index disambiguates ops that share a kind and have no caller id.
    const who = `op '${op.id ?? `${op.op}#${i}`}'`;
    switch (op.op) {
      case 'set_keymap': {
        writeCount++;
        const layer = op.layer;
        const system = op.system ?? 0;
        const target = `${layer}:${system}`;
        const cur = keymapTargets.get(target) ?? { count: 0 };
        cur.count++;
        const arg = keymapArgOf(layer, system);
        for (const e of op.entries) claimSlot(arg, e.index, who, i);
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
        if (!op.delete && op.bind_key !== undefined) {
          // Executor binds on (bind_layer, system 0) → arg = bind_layer.
          claimSlot((op.bind_layer ?? 0) & 3, op.bind_key, `${who} (macro bind)`, i);
        }
        break;
      }
      case 'set_adv': {
        writeCount++;
        advOps++;
        // adv rewrites the arg-0 key-configuration channel; `tgl`'s
        // `toggle` key is only READ (its value is stored in history).
        const written = op.mode === 'socd' ? [op.key_a, op.key_b] : [op.key];
        for (const k of written) {
          if (typeof k === 'number') {
            const prev = advKeys.get(k);
            if (prev && prev.uid !== i) {
              warnings.push(
                `adv key ${k} is bound by both ${prev.who} and ${who} — the later adv write wins that slot`,
              );
            }
            advKeys.set(k, { who, uid: i });
            claimSlot(0, k, `${who} (adv ${op.mode})`, i);
          }
        }
        break;
      }
      case 'set_light': {
        writeCount++;
        const cfg =
          typeof op.config === 'object' && op.config !== null
            ? (op.config as Record<string, unknown>)
            : {};
        if (typeof cfg.mode === 'number') lightModeSetters.push(who);
        break;
      }
      case 'set_profile_section': {
        writeCount++;
        const prev = profileSections.get(op.section);
        if (prev) {
          errors.push(
            `profile section '${op.section}' is written by both ${prev} and ${who} — merge into one op`,
          );
        } else {
          profileSections.set(op.section, who);
        }
        break;
      }
      case 'restore_snapshot': {
        restoreCount++;
        if (firstRestoreAt < 0) firstRestoreAt = i;
        break;
      }
    }
  });

  for (const [target, t] of keymapTargets) {
    if (t.count > 1) {
      errors.push(
        `${t.count} set_keymap ops target layer/system ${target} — merge them into one op (writes are whole-table; last would silently win)`,
      );
    }
  }

  // Whole-effect duplicates: two set_light ops that both pick a mode
  // fight over the same profile field — last wins silently.
  if (lightModeSetters.length > 1) {
    errors.push(
      `${lightModeSetters.length} set_light ops set 'mode' (${lightModeSetters.join(', ')}) — merge them; the last mode wins`,
    );
  }

  // Every set_adv op rewrites the SAME 512-byte history blob; multiple
  // binds compose only through read-modify-write, so flag the plan for
  // a careful review rather than blocking it.
  if (advOps > 1) {
    warnings.push(
      `${advOps} set_adv ops share the single adv-key history blob and arg-0 keymap channel — verify the combined binds on the device`,
    );
  }

  // restore_snapshot must be the LAST write: the planner already orders
  // it so, but a hand-built/forged plan could interleave — a later write
  // would silently overwrite the restore.
  if (firstRestoreAt >= 0) {
    const trailing = plan.ops.slice(firstRestoreAt + 1).filter((p) => p.op.op !== 'restore_snapshot');
    if (trailing.length > 0) {
      errors.push(
        'restore_snapshot is not the last op — later writes would overwrite the restored state; move the restore to the end',
      );
    }
    if (restoreCount > 1) {
      const seen = new Map<string, string>();
      plan.ops.forEach((pop, i) => {
        if (pop.op.op !== 'restore_snapshot') return;
        const who = `op '${pop.op.id ?? `${pop.op.op}#${i}`}'`;
        for (const s of pop.op.sections ?? ['keymap', 'lighting', 'macro', 'profile']) {
          const prev = seen.get(s);
          if (prev) {
            warnings.push(
              `snapshot section '${s}' is restored by both ${prev} and ${who} — the later restore wins`,
            );
          } else {
            seen.set(s, who);
          }
        }
      });
    }
    if (writeCount > 0) {
      warnings.push(
        'restore_snapshot runs last — earlier write ops in this plan will be overwritten by the restore',
      );
    }
  }

  // Friction: large plans get a review warning (each op ≥1 device write;
  // restore_snapshot expands to several).
  if (plan.ops.length > WRITE_FRICTION_OPS) {
    warnings.push(
      `plan has ${plan.ops.length} ops — a large change set; review the diff and expect multiple device writes`,
    );
  }

  // Aggregate macro-region budget: per-op checks pass individually, but
  // several NEW macros can jointly exceed the free space.
  macroAggregateCheck(plan, context, errors);
}

// ── Lighting op interactions ───────────────────────────────────────────

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Cross-field checks inside one set_light config, using the vendor mode
 * table (proto/light.ts — same rules `lighting-scenes.ts::sceneIssues`
 * applies in the UI):
 *
 *  - per-key colour table (keys.colors / keys.entries) only displays in
 *    'custom' mode (277); writing it under another mode succeeds on the
 *    wire but shows nothing → warning.
 *  - a group colour (color / keys.color) needs a colour slot at
 *    mode*21 in the light-data blob; modes whose slot lies past
 *    LIGHT_DATA_MAX (e.g. 275/277) make the executor's write fail →
 *    error. Mode 0 writes succeed but light nothing → warning.
 *  - speed/brightness are ignored by special modes; colour fields only
 *    apply to single-colour modes → warnings.
 *
 * The effective mode falls back to the device context's current mode
 * when the config doesn't set one (same fallback the executor uses).
 */
function lightInteractionChecks(
  pop: AgentPlanOp,
  context: DeviceContext,
  errors: string[],
  warnings: string[],
): void {
  const op = pop.op;
  if (op.op !== 'set_light') return;
  const cfg = isRecord(op.config) ? op.config : {};
  const keys = isRecord(cfg.keys) ? cfg.keys : {};
  const who = `op '${op.id ?? op.op}'`;

  const cfgMode = typeof cfg.mode === 'number' ? cfg.mode : undefined;
  const mode = cfgMode ?? context.lighting?.mode;
  const info = mode !== undefined ? lightModeInfo(mode) : undefined;

  const hasPerKey =
    Array.isArray(keys.colors) ||
    (Array.isArray(keys.entries) && keys.entries.length > 0);
  const hasGroupColor = cfg.color !== undefined || keys.color !== undefined;

  if (hasPerKey) {
    if (mode === 0) {
      warnings.push(
        `${who}: per-key colours are written while lighting mode is 'off' — nothing will be visible`,
      );
    } else if (mode !== undefined && mode !== 277) {
      warnings.push(
        `${who}: the 126-slot per-key colour table only displays in 'custom' mode (277) — mode ${mode}${info ? ` (${info.name})` : ''} won't show it; add "mode": 277 to the same config`,
      );
    }
  }

  if (hasGroupColor && mode !== undefined) {
    const slotEnd = mode * LIGHT_GROUP_STRIDE + LIGHT_GROUP_COLOR_LEN;
    if (slotEnd > LIGHT_DATA_MAX) {
      errors.push(
        `${who}: mode ${mode} has no colour slot in the light-data blob (slot would end at byte ${slotEnd}, cap ${LIGHT_DATA_MAX}) — the group-colour write would fail; pick an effect mode`,
      );
    } else if (mode === 0) {
      warnings.push(`${who}: group colour written while mode is 'off' — no visible effect`);
    } else if (info && info.colorSupport !== COLOR_SUPPORT.SINGLE) {
      warnings.push(
        `${who}: mode ${mode} (${info.name}) does not use a single accent colour — the group colour is stored but likely ignored`,
      );
    }
  }

  if (
    mode !== undefined &&
    LIGHT_SPECIAL_MODES.includes(mode) &&
    (cfg.speed !== undefined || cfg.brightness !== undefined)
  ) {
    warnings.push(
      `${who}: mode ${mode} is a special effect — the firmware ignores speed/brightness for it`,
    );
  }
  if (
    cfg.color_model !== undefined &&
    info &&
    info.colorSupport !== COLOR_SUPPORT.SINGLE
  ) {
    warnings.push(`${who}: colour_model only applies to single-colour effects (mode ${mode})`);
  }
}

// ── Aggregate macro budget ─────────────────────────────────────────────

/**
 * Sum the region bytes every non-delete set_macro op needs (minus the
 * credit for macros it replaces) and compare against the free space the
 * context reported. Per-op `macroStorageCheck` only sees one op at a
 * time — two new macros can each fit yet overflow together.
 */
function macroAggregateCheck(
  plan: AgentPlan,
  context: DeviceContext,
  errors: string[],
): void {
  const free = context.state.macroFreeBytes;
  if (free === undefined) return;

  let needed = 0;
  let credit = 0;
  let writes = 0;
  for (const pop of plan.ops) {
    const op = pop.op;
    if (op.op !== 'set_macro' || op.delete) continue;
    writes++;
    const steps = macroStepCount(op);
    needed += macroSpaceNeeded(op.name ?? '', steps);
    // Replacing frees the old body: match by name, or by index into the
    // context's region-ordered macro list.
    const existing =
      op.name !== undefined
        ? context.macros.find((m) => m.name.toLowerCase() === op.name!.toLowerCase())
        : op.index !== undefined && op.index < context.macros.length
          ? context.macros[op.index]
          : undefined;
    if (existing) {
      credit += 1 + new TextEncoder().encode(existing.name).length + existing.steps * 4;
    }
  }
  if (writes > 1 && needed - credit > free) {
    errors.push(
      `${writes} set_macro ops need ~${needed} region bytes total (~${needed - credit} after replace credits) but only ~${free} are free — delete unused macros first`,
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
    lightInteractionChecks(pop, context, errors, warnings);
  }

  conflictChecks(plan, context, errors, warnings);

  return { ok: errors.length === 0, errors, warnings };
}
