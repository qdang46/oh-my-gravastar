/**
 * Configuration simulator — bead oh-my-gravastar-3n0
 * ("preview changes without writing").
 *
 * `simulate()` / `simulatePlan()` compose the EXISTING pipeline —
 * `planner.ts::planFromOps` (schema validation, ordering, policy class,
 * diff lines) and `validator.ts::validatePlanAgainstContext` (capability,
 * policy, conflict and storage gates) — and add a human-readable
 * before→after summary plus an ESTIMATED device-write count and order.
 *
 * Nothing here touches a device: the write estimate mirrors the lowering
 * rules in `executor.ts` (one PlannedOp per write path) without needing a
 * session, so the layer stays DOM-free and Node-testable. When the
 * executor's `lowerOp` grows a new write path, update
 * `estimateWrites()` here to match — the estimate is a preview aid, not
 * the source of truth (the executor's `dryRun` preview is).
 *
 * `DeviceContext` is optional but strongly recommended: without it the
 * before→after lines degrade to "unknown → new" instead of showing the
 * current labels/values.
 */

import { keyValueLabelOf } from '../proto/khub916.ts';
import { lightModeInfo } from '../proto/light.ts';
import type { AgentOp } from './action-schema.ts';
import type { DeviceContext } from './device-context.ts';
import { planFromOps, type AgentPlan, type AgentPlanOp } from './planner.ts';
import { validatePlanAgainstContext, type PlanValidation } from './validator.ts';

// ── Simulation shape ───────────────────────────────────────────────────

/** One keymap slot before→after. `before` is absent without a context. */
export interface SimKeyChange {
  /** Keymap slot index (0..127). */
  index: number;
  /** Label of the current value (e.g. "KeyA"), when the context has it. */
  before?: string;
  /** Label of the value the op would write. */
  after: string;
}

export interface SimulationSection {
  /** Planner section label: keymap | lighting | macro | advkeys | profile | snapshot. */
  section: string;
  /** Human-readable before→after lines for this section. */
  lines: string[];
  /** Estimated device writes for the ops in this section. */
  writeOps: number;
}

export interface Simulation {
  /** Per-section before→after summaries, in plan (execution) order. */
  sections: SimulationSection[];
  /** Distinct keymap slots the plan writes (keymap + adv + macro bind). */
  affectedKeys: number;
  /** Per-slot before→after detail behind `affectedKeys`. */
  keyChanges: SimKeyChange[];
  /** Flat convenience views (subset of `sections[].lines`). */
  lighting: string[];
  macro: string[];
  profile: string[];
  /** Sum of `sections[].writeOps` — ESTIMATE, see file header. */
  estimatedWriteOps: number;
  /** Ordered write labels — mirrors the executor's PlannedOp order. */
  writeOrder: string[];
  /** Plan + validator warnings (deduped). */
  warnings: string[];
  /** Plan + validator errors — non-empty means do not run. */
  errors: string[];
  /** True when any op needs L2/L3 approval. */
  requiresApproval: boolean;
  /** Always true — the simulator never sends anything. */
  dryRun: true;
  /** One-line-per-change summary (== sections' lines, flattened). */
  summary: string[];
}

export interface SimulationResult {
  plan: AgentPlan;
  validation: PlanValidation;
  simulation: Simulation;
}

// ── Context lookups ────────────────────────────────────────────────────

/** arg packing shared with executor.ts::keymapArg / rollback.ts. */
function keymapArg(layer: number, system: number): number {
  return (layer & 3) | ((system & 1) << 2);
}

/** Current label for a keymap slot, from the context's read summaries. */
function currentKeyLabel(
  context: DeviceContext | undefined,
  layer: number,
  system: number,
  index: number,
): string | undefined {
  const arg = keymapArg(layer, system);
  const km = context?.keymaps.find((k) => k.arg === arg);
  if (!km) return undefined;
  // `entries` only lists non-zero slots; fall back to `values` for zero.
  const e = km.entries.find((x) => x.index === index);
  if (e) return e.label;
  const v = km.values[index];
  if (v === undefined || v === 0) return '—';
  return keyValueLabelOf(v >>> 0);
}

function fmtRgb(c: unknown): string {
  if (typeof c !== 'object' || c === null) return String(c);
  const r = (c as { r?: unknown }).r;
  const g = (c as { g?: unknown }).g;
  const b = (c as { b?: unknown }).b;
  if (typeof r === 'number' && typeof g === 'number' && typeof b === 'number') {
    const h = (n: number) => n.toString(16).padStart(2, '0');
    return `#${h(r & 0xff)}${h(g & 0xff)}${h(b & 0xff)}`;
  }
  return JSON.stringify(c);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// ── Per-op simulation ──────────────────────────────────────────────────

interface OpSim {
  section: string;
  lines: string[];
  writeOps: number;
  /** Ordered write labels (executor-lowering order within the op). */
  writeLabels: string[];
  keyChanges: SimKeyChange[];
}

function simSetKeymap(pop: AgentPlanOp, context: DeviceContext | undefined): OpSim {
  const op = pop.op as Extract<AgentOp, { op: 'set_keymap' }>;
  const system = op.system ?? 0;
  const keyChanges: SimKeyChange[] = op.entries.map((e) => {
    const before = currentKeyLabel(context, op.layer, system, e.index);
    const after = keyValueLabelOf(e.value >>> 0);
    return {
      index: e.index,
      ...(before !== undefined ? { before } : {}),
      after,
    };
  });
  const lines = keyChanges.map(
    (k) => `keymap L${op.layer}/S${system} slot ${k.index}: ${k.before ?? '?'} → ${k.after}`,
  );
  return {
    section: pop.section,
    lines,
    writeOps: 1,
    writeLabels: [pop.diff],
    keyChanges,
  };
}

function simSetLight(pop: AgentPlanOp, context: DeviceContext | undefined): OpSim {
  const op = pop.op as Extract<AgentOp, { op: 'set_light' }>;
  const cfg = isRecord(op.config) ? op.config : {};
  const keys = isRecord(cfg.keys) ? cfg.keys : {};
  const lines: string[] = [];
  const writeLabels: string[] = [];
  let writes = 0;

  const cur = context?.lighting;
  const curMode =
    cur?.modeName ??
    (cur !== undefined ? lightModeInfo(cur.mode)?.name : undefined) ??
    (context?.state.lightingMode !== undefined
      ? lightModeInfo(context.state.lightingMode)?.name
      : undefined);

  if (cfg.mode !== undefined) {
    const name = typeof cfg.mode === 'number' ? lightModeInfo(cfg.mode)?.name : undefined;
    lines.push(`lighting mode: ${curMode ?? '?'} → ${name ?? String(cfg.mode)}`);
  }
  if (cfg.speed !== undefined) {
    lines.push(`lighting speed: ${cur?.speed ?? '?'} → ${String(cfg.speed)}`);
  }
  if (cfg.brightness !== undefined) {
    lines.push(`lighting brightness: ${cur?.brightness ?? '?'} → ${String(cfg.brightness)}`);
  }
  if (cfg.color_model !== undefined) {
    lines.push(`lighting colour model: ${cur?.colorModel ?? '?'} → ${String(cfg.color_model)}`);
  }
  const groupColorInput = cfg.color ?? keys.color;
  if (groupColorInput !== undefined) {
    const before = cur?.color ? fmtRgb(cur.color) : '?';
    lines.push(`lighting group colour: ${before} → ${fmtRgb(groupColorInput)}`);
  }
  if (Array.isArray(keys.colors)) {
    lines.push(`lighting: replace all ${keys.colors.length} custom colour slots`);
  }
  if (Array.isArray(keys.entries)) {
    const n = (keys.entries as unknown[]).length;
    lines.push(`lighting: update ${n} custom colour slot${n === 1 ? '' : 's'}`);
  }
  if (lines.length === 0) {
    lines.push(pop.diff);
  }

  // Mirror lowerSetLight's write split (executor.ts).
  const hasProfileFields =
    cfg.mode !== undefined ||
    cfg.speed !== undefined ||
    cfg.brightness !== undefined ||
    cfg.color_model !== undefined;
  if (hasProfileFields) {
    writes++;
    writeLabels.push(`${pop.diff} (mode/speed/brightness)`);
  }
  if (groupColorInput !== undefined) {
    writes++;
    writeLabels.push(`${pop.diff} (group colour)`);
  }
  if (Array.isArray(keys.colors)) {
    writes++;
    writeLabels.push(`${pop.diff} (126 custom colours)`);
  }
  if (Array.isArray(keys.entries)) {
    writes++;
    writeLabels.push(`${pop.diff} (${(keys.entries as unknown[]).length} colour slot(s))`);
  }
  return { section: pop.section, lines, writeOps: writes, writeLabels, keyChanges: [] };
}

function macroStepCount(op: Extract<AgentOp, { op: 'set_macro' }>): number {
  if (Array.isArray(op.steps)) return op.steps.length;
  if (isRecord(op.steps) && Array.isArray(op.steps.steps)) return op.steps.steps.length;
  return 0;
}

function simSetMacro(pop: AgentPlanOp, context: DeviceContext | undefined): OpSim {
  const op = pop.op as Extract<AgentOp, { op: 'set_macro' }>;
  const label = op.name ?? `#${op.index}`;
  const existing =
    op.name !== undefined
      ? context?.macros.find((m) => m.name.toLowerCase() === op.name!.toLowerCase())
      : undefined;

  let line: string;
  if (op.delete) {
    line = `macro '${label}': delete${existing ? ` (was ${existing.steps} step(s))` : ''}`;
  } else {
    const steps = macroStepCount(op);
    const action = existing ? `replace (${existing.steps} → ${steps} step(s))` : `new (${steps} step(s))`;
    line = `macro '${label}': ${action}`;
  }
  if (op.bind_key !== undefined && !op.delete) {
    line += ` + bind on keymap slot ${op.bind_key} (layer ${op.bind_layer ?? 0})`;
  }

  const writeLabels = [pop.diff];
  if (op.bind_key !== undefined && !op.delete) writeLabels.push(`${pop.diff} (key bind)`);
  const keyChanges: SimKeyChange[] =
    op.bind_key !== undefined && !op.delete
      ? [
          {
            index: op.bind_key,
            after: `macro '${label}'`,
          },
        ]
      : [];

  return {
    section: pop.section,
    lines: [line],
    writeOps: writeLabels.length,
    writeLabels,
    keyChanges,
  };
}

function simSetAdv(pop: AgentPlanOp): OpSim {
  const op = pop.op as Extract<AgentOp, { op: 'set_adv' }>;
  // Written slots: mt/tgl → `key`; socd → `key_a`+`key_b`. `toggle` is
  // read-only (validator conflictChecks documents this).
  const written: number[] = [];
  if (op.mode === 'socd') {
    for (const k of [op.key_a, op.key_b]) {
      if (typeof k === 'number') written.push(k);
    }
  } else if (typeof op.key === 'number') {
    written.push(op.key);
  }
  const keyChanges: SimKeyChange[] = [...new Set(written)].map((index) => ({
    index,
    after: `adv ${op.mode}`,
  }));
  return {
    section: pop.section,
    lines: [pop.diff],
    // Vendor two-write path: keymap channel + adv history blob.
    writeOps: 2,
    writeLabels: [`${pop.diff} (keymap channel)`, `${pop.diff} (adv blob)`],
    keyChanges,
  };
}

function simRestoreSnapshot(pop: AgentPlanOp): OpSim {
  const op = pop.op as Extract<AgentOp, { op: 'restore_snapshot' }>;
  const secs = op.sections ?? ['keymap', 'lighting', 'macro', 'profile'];
  // Estimate: ≥1 device write per restored section (keymap can fan out
  // per arg; the exact count needs the snapshot blob).
  return {
    section: pop.section,
    lines: [`restore snapshot ${op.id}: ${secs.join(', ')}`],
    writeOps: secs.length,
    writeLabels: secs.map((s) => `${pop.diff} (${s})`),
    keyChanges: [],
  };
}

function simSetProfileSection(pop: AgentPlanOp, context: DeviceContext | undefined): OpSim {
  const op = pop.op as Extract<AgentOp, { op: 'set_profile_section' }>;
  const before =
    op.section === 'sleep_seconds' ? context?.state.sleepSeconds : undefined;
  return {
    section: pop.section,
    lines: [
      `profile ${op.section}: ${before ?? '?'} → ${op.value}` +
        (op.section === 'sleep_seconds' ? ' (seconds)' : ''),
    ],
    writeOps: 1,
    writeLabels: [pop.diff],
    keyChanges: [],
  };
}

function simOp(pop: AgentPlanOp, context: DeviceContext | undefined): OpSim {
  switch (pop.op.op) {
    case 'set_keymap':
      return simSetKeymap(pop, context);
    case 'set_light':
      return simSetLight(pop, context);
    case 'set_macro':
      return simSetMacro(pop, context);
    case 'set_adv':
      return simSetAdv(pop);
    case 'restore_snapshot':
      return simRestoreSnapshot(pop);
    case 'set_profile_section':
      return simSetProfileSection(pop, context);
    default:
      return {
        section: pop.section,
        lines: [pop.diff],
        writeOps: 0,
        writeLabels: [],
        keyChanges: [],
      };
  }
}

// ── Public API ─────────────────────────────────────────────────────────

/**
 * Build the simulation for an already-planned `AgentPlan`. Runs the
 * context-aware validator (same gate the executor uses) so capability,
 * policy and conflict findings appear in `simulation`-adjacent fields.
 */
export function simulatePlan(
  plan: AgentPlan,
  context?: DeviceContext,
): SimulationResult {
  const validation: PlanValidation = context
    ? validatePlanAgainstContext(plan, context)
    : plan.valid
      ? { ok: true, errors: [], warnings: plan.warnings }
      : { ok: false, errors: [...plan.errors], warnings: plan.warnings };

  const warnings = [...new Set([...plan.warnings, ...validation.warnings])];
  const errors = [...new Set([...plan.errors, ...validation.errors])];

  // Group op sims by section, preserving plan (execution) order.
  const sections: SimulationSection[] = [];
  const bySection = new Map<string, SimulationSection>();
  const keyChanges: SimKeyChange[] = [];
  const keySet = new Set<number>();
  const writeOrder: string[] = [];
  const lighting: string[] = [];
  const macro: string[] = [];
  const profile: string[] = [];

  for (const pop of plan.ops) {
    const sim = simOp(pop, context);
    let sec = bySection.get(sim.section);
    if (!sec) {
      sec = { section: sim.section, lines: [], writeOps: 0 };
      bySection.set(sim.section, sec);
      sections.push(sec);
    }
    sec.lines.push(...sim.lines);
    sec.writeOps += sim.writeOps;
    writeOrder.push(...sim.writeLabels);
    for (const k of sim.keyChanges) {
      if (!keySet.has(k.index)) {
        keySet.add(k.index);
        keyChanges.push(k);
      }
    }
    if (sim.section === 'lighting') lighting.push(...sim.lines);
    else if (sim.section === 'macro') macro.push(...sim.lines);
    else if (sim.section === 'profile') profile.push(...sim.lines);
  }

  if (simSetLightProducesNoWrites(plan)) {
    warnings.push('a set_light op maps to no device write — the executor will reject it');
  }

  const simulation: Simulation = {
    sections,
    affectedKeys: keySet.size,
    keyChanges,
    lighting,
    macro,
    profile,
    estimatedWriteOps: sections.reduce((n, s) => n + s.writeOps, 0),
    writeOrder,
    warnings,
    errors,
    requiresApproval: plan.requiresApproval,
    dryRun: true,
    summary: sections.flatMap((s) => s.lines),
  };

  return { plan, validation, simulation };
}

/** True when a set_light config has none of the executor-mapped fields. */
function simSetLightProducesNoWrites(plan: AgentPlan): boolean {
  for (const pop of plan.ops) {
    if (pop.op.op !== 'set_light') continue;
    const cfg = isRecord(pop.op.config) ? pop.op.config : {};
    const keys = isRecord(cfg.keys) ? cfg.keys : {};
    const mapped =
      cfg.mode !== undefined ||
      cfg.speed !== undefined ||
      cfg.brightness !== undefined ||
      cfg.color_model !== undefined ||
      cfg.color !== undefined ||
      keys.color !== undefined ||
      Array.isArray(keys.colors) ||
      Array.isArray(keys.entries);
    if (!mapped) return true;
  }
  return false;
}

/**
 * One-call preview: raw ops → plan → validation → simulation.
 * `context` is optional; pass a `DeviceContext` (from
 * `buildDeviceContext`) for before→after labels and storage checks.
 */
export function simulate(
  ops: readonly unknown[],
  context?: DeviceContext,
): SimulationResult {
  return simulatePlan(planFromOps(ops, context), context);
}
