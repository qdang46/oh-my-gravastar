/**
 * Plan executor — `docs/AGENT-ARCHITECTURE.md` §1/§4 and SAFETY-SPEC §4.
 *
 * HARD RULE (vision "Strategic rules" #1): agents never call HID writes
 * directly. `executePlan()` lowers each validated `AgentOp` into
 * `PlannedOp`s whose `apply()` closures call the session's existing
 * read-back-verified write methods, then runs them through
 * `safety/transaction.ts::runTransaction` — policy approval, sequential
 * execution, stop-on-first-failure and the honest journal all apply.
 *
 * `dryRun: true` returns the plan + validation + a `dryRun()` preview and
 * NEVER invokes `apply` — safe for "what would this do?".
 *
 * The session contract (`AgentSession`) is structural: `Khub916Session`
 * (hid.ts) satisfies it; tests inject mocks. Every write method is
 * optional — a missing path fails honestly inside the transaction
 * instead of being silently skipped.
 */

import { parseStepsJson } from '../proto/macro916.ts';
import {
  buildMacroRegion,
  macroKeyValue,
  parseMacroRegion,
  type MacroEntry,
} from '../proto/macro916.ts';
import {
  COLOR_MODEL,
  CUSTOM_LIGHT_SLOTS,
  decodeLightState,
  parseColor,
  withGroupColor,
  withLightMode,
  type Rgb,
} from '../proto/light.ts';
import { planMt, planSocd, planTgl, type AdvPlan } from '../proto/advkey916.ts';
import { profileWithSleepSeconds } from '../proto/khub916.ts';
import { planRestore, type RestoreWriter } from '../safety/rollback.ts';
import type { SnapshotStore } from '../safety/snapshots.ts';
import {
  dryRun as txDryRun,
  runTransaction,
  type DryRunPlan,
  type PlannedOp,
  type TransactionOptions,
  type TransactionResult,
  type WriteOutcomeLike,
} from '../safety/transaction.ts';
import type { AgentOp } from './action-schema.ts';
import type { DeviceContext, DeviceReader } from './device-context.ts';
import type { AgentPlan, AgentPlanOp } from './planner.ts';
import { validatePlanAgainstContext, type PlanValidation } from './validator.ts';

// ── Session contract ───────────────────────────────────────────────────

/**
 * Everything the executor may call on a device session. Read methods
 * come from `DeviceReader` (device-context.ts); write methods mirror
 * `RestoreWriter` (safety/rollback.ts) plus the adv-key and
 * key-configuration channels. All optional — lowering fails honestly
 * when a path is absent.
 */
export interface AgentSession extends DeviceReader, RestoreWriter {
  writeKeymap?(layer: number, system: number, values: readonly number[]): Promise<WriteOutcomeLike>;
  writeKeyConfiguration?(values: readonly number[]): Promise<WriteOutcomeLike>;
  writeProfile?(blob: Uint8Array): Promise<WriteOutcomeLike>;
  writeLightData?(data: Uint8Array): Promise<WriteOutcomeLike>;
  writeCustomLightColors?(colors: readonly Rgb[]): Promise<WriteOutcomeLike>;
  writeMacroRegion?(data: Uint8Array): Promise<WriteOutcomeLike>;
  writeAdvKeyConfig?(blob: Uint8Array): Promise<WriteOutcomeLike>;
}

export interface ExecuteOptions {
  /** The resolved device session (writes go through its verified methods). */
  session: AgentSession;
  /**
   * Approval gate forwarded to `runTransaction`. `true` approves every
   * gated op; a function is called per L2/L3 op; omitted/false denies —
   * the safety-first default.
   */
  approve?: boolean | TransactionOptions['approve'];
  /** When true, return plan + validation + preview; nothing is sent. */
  dryRun?: boolean;
  /** Device context for the validator; strongly recommended. */
  context?: DeviceContext;
  /** SnapshotStore for restore_snapshot ops. */
  snapshots?: SnapshotStore;
  /** Audit sink forwarded to the transaction. */
  audit?: TransactionOptions['audit'];
}

export interface ExecuteResult {
  ok: boolean;
  dryRun: boolean;
  plan: AgentPlan;
  validation: PlanValidation;
  /** Policy preview — present on dry runs (and real runs, harmless). */
  preview?: DryRunPlan;
  /** Full transaction journal — present on real runs. */
  tx?: TransactionResult;
  /** Labels of ops that applied successfully. */
  applied: string[];
  /** First failure description, when the run stopped early. */
  failed?: string;
  /** True when every applied op verified its read-back. */
  verified: boolean;
  errors: string[];
}

// ── Lowering helpers ───────────────────────────────────────────────────

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function need<T>(fn: T | undefined, name: string): T {
  if (fn === undefined) {
    throw new Error(`no ${name} path on this session`);
  }
  return fn;
}

/** arg = layer | system<<2 — same packing as hid.ts writeKeymap. */
function keymapArg(layer: number, system: number): number {
  return (layer & 3) | ((system & 1) << 2);
}

/**
 * Read the current u32 table for a layer/system. Prefers `keyValues`
 * (cmd 131); falls back to `keymap` decoded entries when only that read
 * exists. Returns a mutable copy.
 */
async function readKeymapValues(
  session: AgentSession,
  layer: number,
  system: number,
): Promise<number[]> {
  const arg = keymapArg(layer, system);
  if (session.keyValues) {
    return (await session.keyValues(arg)).map((v) => v >>> 0);
  }
  if (session.keymap) {
    const decoded = await session.keymap(arg);
    const values = decoded.map((e) => e.value >>> 0);
    return values;
  }
  throw new Error('no keymap read path on this session');
}

/** Patch `values` with sparse entries (zero-padded growth). */
function patchValues(
  values: readonly number[],
  entries: readonly { index: number; value: number }[],
): number[] {
  const out = values.map((v) => v >>> 0);
  for (const e of entries) {
    while (out.length <= e.index) out.push(0);
    out[e.index] = e.value >>> 0;
  }
  return out;
}

// ── Per-op lowering ────────────────────────────────────────────────────

function lowerSetKeymap(pop: AgentPlanOp, session: AgentSession): PlannedOp[] {
  const op = pop.op as Extract<AgentOp, { op: 'set_keymap' }>;
  const layer = op.layer;
  const system = op.system ?? 0;
  return [
    {
      type: 'keymap_write',
      section: 'keymap',
      label: pop.diff,
      payload: { layer, system, entries: op.entries },
      apply: async () => {
        const current = await readKeymapValues(session, layer, system);
        const values = patchValues(current, op.entries);
        const w = need(session.writeKeymap, 'keymap');
        return w.call(session, layer, system, values);
      },
    },
  ];
}

function lowerSetLight(pop: AgentPlanOp, session: AgentSession): PlannedOp[] {
  const op = pop.op as Extract<AgentOp, { op: 'set_light' }>;
  const cfg = (typeof op.config === 'object' && op.config !== null
    ? op.config
    : {}) as Record<string, unknown>;
  const keys = (typeof cfg.keys === 'object' && cfg.keys !== null
    ? cfg.keys
    : {}) as Record<string, unknown>;
  const ops: PlannedOp[] = [];

  const hasProfileFields =
    cfg.mode !== undefined ||
    cfg.speed !== undefined ||
    cfg.brightness !== undefined ||
    cfg.color_model !== undefined;

  if (hasProfileFields) {
    ops.push({
      type: 'settings_write',
      section: 'lighting',
      label: `${pop.diff} (mode/speed/brightness)`,
      payload: { mode: cfg.mode, speed: cfg.speed, brightness: cfg.brightness, color_model: cfg.color_model },
      apply: async () => {
        const readProfile = need(session.profile?.bind(session), 'profile');
        const writeProfile = need(session.writeProfile, 'profile');
        const profile = await readProfile();
        const cur = decodeLightState(profile.raw);
        const mode = typeof cfg.mode === 'number' ? cfg.mode : (cur?.mode ?? 0);
        const speed = typeof cfg.speed === 'number' ? cfg.speed : (cur?.speed ?? 0);
        const bright = typeof cfg.brightness === 'number' ? cfg.brightness : (cur?.brightness ?? 0);
        const colorModel =
          typeof cfg.color_model === 'number' ? cfg.color_model : (cur?.colorModel ?? COLOR_MODEL.MIXING);
        const blob = withLightMode(profile.raw, mode, speed, bright, colorModel);
        return writeProfile.call(session, blob);
      },
    });
  }

  // Group colour for the active mode (top-level `color` or `keys.color`).
  const groupColorInput = cfg.color ?? keys.color;
  if (groupColorInput !== undefined) {
    ops.push({
      type: 'light_write',
      section: 'lighting',
      label: `${pop.diff} (group colour)`,
      apply: async () => {
        const readData = need(session.lightColorData?.bind(session), 'light-data');
        const writeData = need(session.writeLightData, 'light-data');
        const readProfile = session.profile?.bind(session);
        let mode = 0;
        if (readProfile && typeof cfg.mode === 'number') {
          mode = cfg.mode;
        } else if (readProfile) {
          const profile = await readProfile();
          mode = decodeLightState(profile.raw)?.mode ?? 0;
        } else if (typeof cfg.mode === 'number') {
          mode = cfg.mode;
        }
        const blob = await readData();
        const next = withGroupColor(blob, mode, parseColor(groupColorInput, 'set_light colour'));
        if (next === null) {
          throw new Error(`light mode ${mode} has no colour slot in the device blob`);
        }
        return writeData.call(session, next);
      },
    });
  }

  // Full 126-slot custom colour table.
  if (Array.isArray(keys.colors)) {
    ops.push({
      type: 'light_write',
      section: 'lighting',
      label: `${pop.diff} (126 custom colours)`,
      apply: async () => {
        const write = need(session.writeCustomLightColors, 'custom-light-colours');
        const colors = (keys.colors as unknown[]).map((c) => parseColor(c, 'set_light keys.colors'));
        return write.call(session, colors);
      },
    });
  }

  // Sparse per-slot colour entries → read-modify-write the 126 table.
  if (Array.isArray(keys.entries)) {
    ops.push({
      type: 'light_write',
      section: 'lighting',
      label: `${pop.diff} (${(keys.entries as unknown[]).length} colour slot(s))`,
      apply: async () => {
        const readColors = need(session.customLightColors?.bind(session), 'custom-light-colours');
        const write = need(session.writeCustomLightColors, 'custom-light-colours');
        const current = await readColors();
        const table: Rgb[] = current.map((c) => ({ r: c.r & 0xff, g: c.g & 0xff, b: c.b & 0xff }));
        while (table.length < CUSTOM_LIGHT_SLOTS) table.push({ r: 0, g: 0, b: 0 });
        for (const [i, e] of (keys.entries as unknown[]).entries()) {
          if (typeof e !== 'object' || e === null) {
            throw new Error(`set_light keys.entries[${i}] is not an object`);
          }
          const entry = e as Record<string, unknown>;
          // `index`/`pos` are the 0..125 colour slot (same range the
          // safety validator enforces — see validateLightConfig).
          const index = entry.index ?? entry.pos;
          if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= CUSTOM_LIGHT_SLOTS) {
            throw new Error(`set_light keys.entries[${i}]: index/pos must be an integer 0..${CUSTOM_LIGHT_SLOTS - 1}`);
          }
          table[index] = parseColor(entry.color, `set_light keys.entries[${i}].color`);
        }
        return write.call(session, table);
      },
    });
  }

  if (ops.length === 0) {
    // validateLightConfig guarantees ≥1 field; anything unmapped lands here.
    throw new Error('set_light config has no mapped device write (preset/gradient fields are rejected at validation)');
  }
  return ops;
}

function lowerSetMacro(pop: AgentPlanOp, session: AgentSession): PlannedOp[] {
  const op = pop.op as Extract<AgentOp, { op: 'set_macro' }>;
  // Pre-parse steps OUTSIDE apply: conversion errors become plan errors,
  // not mid-transaction failures.
  const stepsInput = op.delete
    ? null
    : parseStepsJson(JSON.stringify(op.steps ?? { steps: [] }));
  let boundIndex = -1;

  const regionOp: PlannedOp = {
    type: 'macro_write',
    section: 'macro',
    label: pop.diff,
    payload: { name: op.name, index: op.index, delete: op.delete === true },
    apply: async () => {
      const readRegion = need(session.macroRegion?.bind(session), 'macro-region');
      const writeRegion = need(session.writeMacroRegion, 'macro-region');
      const region = await readRegion();
      const entries = parseMacroRegion(region);

      let target = -1;
      if (op.name !== undefined) {
        const want = op.name.toLowerCase();
        target = entries.findIndex((e) => e.name.toLowerCase() === want);
      } else if (op.index !== undefined) {
        target = op.index < entries.length ? op.index : -1;
      }

      if (op.delete) {
        if (target < 0) {
          throw new Error(`no macro '${op.name ?? `#${op.index}`}' to delete`);
        }
        entries.splice(target, 1);
        boundIndex = -1;
      } else {
        const name =
          op.name ??
          stepsInput?.name ??
          (target >= 0 ? entries[target]?.name : undefined) ??
          `macro-${entries.length}`;
        const entry: MacroEntry = { name, steps: stepsInput?.steps ?? [] };
        if (target >= 0) {
          entries[target] = entry;
          boundIndex = target;
        } else {
          entries.push(entry);
          boundIndex = entries.length - 1;
        }
      }

      const next = buildMacroRegion(entries);
      return writeRegion.call(session, next);
    },
  };

  const ops: PlannedOp[] = [regionOp];

  if (!op.delete && op.bind_key !== undefined) {
    ops.push({
      type: 'keymap_write',
      section: 'keymap',
      label: `${pop.diff} (key bind)`,
      payload: { bind_key: op.bind_key, bind_layer: op.bind_layer ?? 0 },
      apply: async () => {
        if (boundIndex < 0) {
          throw new Error('macro bind: the macro write did not produce an entry index');
        }
        const layer = op.bind_layer ?? 0;
        const current = await readKeymapValues(session, layer, 0);
        const values = patchValues(current, [
          {
            index: op.bind_key as number,
            value: macroKeyValue(op.macro_type ?? 1, op.loop ?? 1, boundIndex),
          },
        ]);
        const w = need(session.writeKeymap, 'keymap');
        return w.call(session, layer, 0, values);
      },
    });
  }
  return ops;
}

function lowerSetAdv(pop: AgentPlanOp, session: AgentSession): PlannedOp[] {
  const op = pop.op as Extract<AgentOp, { op: 'set_adv' }>;
  // Key refs must already be numeric — the planner resolves layout names.
  const num = (v: number | string | undefined, what: string): number => {
    if (typeof v !== 'number' || !Number.isInteger(v)) {
      throw new Error(`set_adv ${what} was not resolved to a keymap index`);
    }
    return v;
  };
  const tap = typeof op.tap === 'number' ? op.tap : null;
  const hold = typeof op.hold === 'number' ? op.hold : null;

  return [
    {
      type: 'adv_write',
      section: 'advkeys',
      label: pop.diff,
      payload: { mode: op.mode },
      apply: async () => {
        const readBlob = need(session.advKeyConfig?.bind(session), 'adv-key-config');
        const writeKm = need(session.writeKeyConfiguration, 'key-configuration');
        const writeBlob = need(session.writeAdvKeyConfig, 'adv-key-config');

        const blob = await readBlob();
        // keyConfiguration() is the vendor 0/2 arg-0 channel the adv
        // planners rewrite; keyValues(0) is the fallback read.
        const km = session.keyConfiguration
          ? await session.keyConfiguration()
          : session.keyValues
            ? await session.keyValues(0)
            : (() => {
                throw new Error('no keymap read path for adv keys');
              })();

        let plan: AdvPlan;
        if (op.mode === 'mt') {
          if (tap === null || hold === null) throw new Error('set_adv mt: tap/hold missing');
          const time = Math.min(0xffff, Math.max(0, Math.round((op.hold_ms ?? 200) / 10)));
          plan = planMt(blob, km, num(op.key, 'key'), tap, hold, time);
        } else if (op.mode === 'socd') {
          plan = planSocd(
            blob,
            km,
            num(op.key_a, 'key_a'),
            num(op.key_b, 'key_b'),
            op.direction ?? 0,
          );
        } else {
          plan = planTgl(blob, km, num(op.key, 'key'), num(op.toggle, 'toggle'));
        }

        // Vendor order: keymap channel first, then the history blob
        // (advkeys.ts::set — same two writes).
        const kmOut = await writeKm.call(session, plan.keymap);
        const blobOut = await writeBlob.call(session, plan.blob);
        return { verified: kmOut.verified !== false && blobOut.verified !== false };
      },
    },
  ];
}

function lowerRestoreSnapshot(
  pop: AgentPlanOp,
  session: AgentSession,
  snapshots: SnapshotStore | undefined,
): PlannedOp[] {
  const op = pop.op as Extract<AgentOp, { op: 'restore_snapshot' }>;
  if (!snapshots) {
    throw new Error('restore_snapshot needs a SnapshotStore — none supplied');
  }
  const snap = snapshots.get(op.id);
  if (!snap) {
    throw new Error(`no snapshot '${op.id}' — it may have been pruned`);
  }
  // planRestore produces policy-typed PlannedOps bound to the session's
  // verified write methods — the same path the UI restore uses.
  return planRestore(snap, session, op.sections);
}

function lowerSetProfileSection(pop: AgentPlanOp, session: AgentSession): PlannedOp[] {
  const op = pop.op as Extract<AgentOp, { op: 'set_profile_section' }>;
  return [
    {
      type: 'settings_write',
      section: 'profile',
      label: pop.diff,
      payload: { section: op.section, value: op.value },
      apply: async () => {
        const readProfile = need(session.profile?.bind(session), 'profile');
        const writeProfile = need(session.writeProfile, 'profile');
        const profile = await readProfile();
        let blob: Uint8Array;
        if (op.section === 'sleep_seconds') {
          blob = profileWithSleepSeconds(profile.raw, op.value);
        } else {
          throw new Error(`unsupported profile section '${op.section}'`);
        }
        return writeProfile.call(session, blob);
      },
    },
  ];
}

function lowerOp(
  pop: AgentPlanOp,
  session: AgentSession,
  snapshots: SnapshotStore | undefined,
): PlannedOp[] {
  switch (pop.op.op) {
    case 'set_keymap':
      return lowerSetKeymap(pop, session);
    case 'set_light':
      return lowerSetLight(pop, session);
    case 'set_macro':
      return lowerSetMacro(pop, session);
    case 'set_adv':
      return lowerSetAdv(pop, session);
    case 'restore_snapshot':
      return lowerRestoreSnapshot(pop, session, snapshots);
    case 'set_profile_section':
      return lowerSetProfileSection(pop, session);
    default:
      throw new Error(`unknown op kind '${String((pop.op as AgentOp).op)}'`);
  }
}

// ── Public API ─────────────────────────────────────────────────────────

/**
 * Execute a plan. Order of gates:
 *
 *   schema (plan.valid) → context validation → lowering → dry-run preview
 *   or `runTransaction`.
 *
 * A plan that fails any gate returns `ok:false` with `errors` and NEVER
 * touches the device. `dryRun:true` additionally skips `runTransaction`
 * entirely — `apply` closures are built but never invoked.
 */
export async function executePlan(
  plan: AgentPlan,
  opts: ExecuteOptions,
): Promise<ExecuteResult> {
  const dry = opts.dryRun === true;
  const base: ExecuteResult = {
    ok: false,
    dryRun: dry,
    plan,
    validation: { ok: false, errors: [], warnings: [] },
    applied: [],
    verified: false,
    errors: [],
  };

  // 1–2. Schema + context gates (context optional but recommended).
  const validation: PlanValidation = opts.context
    ? validatePlanAgainstContext(plan, opts.context)
    : plan.valid
      ? { ok: true, errors: [], warnings: plan.warnings }
      : { ok: false, errors: [...plan.errors], warnings: plan.warnings };
  base.validation = validation;
  base.errors.push(...validation.errors);

  // 3. Lower ops → PlannedOps. Lowering is pure (closures not invoked);
  //    failures become plan errors, not transaction entries.
  const planned: PlannedOp[] = [];
  for (const pop of plan.ops) {
    try {
      planned.push(...lowerOp(pop, opts.session, opts.snapshots));
    } catch (e) {
      base.errors.push(`${pop.diff}: ${msg(e)}`);
    }
  }
  base.preview = txDryRun(planned);

  if (!plan.valid || !validation.ok || base.errors.length > 0) {
    return base;
  }

  if (dry) {
    base.ok = true;
    base.verified = true; // nothing was written — nothing to verify
    return base;
  }

  // 4. Real run — the ONLY path to device writes.
  const approve =
    opts.approve === true
      ? () => true
      : typeof opts.approve === 'function'
        ? opts.approve
        : undefined;

  const tx = await runTransaction(planned, {
    approve,
    audit: opts.audit,
    session: opts.session,
  });
  base.tx = tx;
  base.applied = tx.journal.filter((j) => j.result !== 'failed').map((j) => j.label ?? j.op);
  const firstFail = tx.journal.find((j) => j.result === 'failed');
  if (firstFail) base.failed = firstFail.error;
  base.verified = tx.journal.every((j) => j.result !== 'unverified' && j.result !== 'failed');
  base.ok = tx.ok && tx.completed;
  return base;
}
