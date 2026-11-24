/**
 * Agent action schema — `docs/AGENT-ARCHITECTURE.md` §3.
 *
 * Closed op vocabulary (schema_version 1) shared by the web agent layer
 * and (later) the CLI `--json` surface. One op = one atomic device
 * mutation; every op carries a `device_selector` so plans stay honest on
 * multi-device setups ("auto | vid:pid | path" — resolution is the
 * caller's job, the schema only requires a non-empty string).
 *
 * `validateOp()` / `validatePlan()` NEVER throw: they return
 * `{ ok, errors }` and reuse the safety-layer validators
 * (`safety/validation.ts`) for the payload shapes that already have a
 * wire contract — keymap u32 values, macro steps
 * (docs/macro-schema.md) and light configs (docs/lighting-schema.md).
 *
 * Validation here is context-free (types, ranges, closed fields). The
 * device-aware gates — capability, policy, conflicts, storage limits —
 * live in `validator.ts`; name→slot resolution lives in `planner.ts`.
 */

import { KEYMAP_ENTRIES } from '../proto/khub916.ts';
import type { SnapshotSectionName } from '../safety/snapshots.ts';
import {
  MAX_MACRO_STEPS,
  validateLightConfig,
  validateMacroSteps,
  type ValidationResult,
} from '../safety/validation.ts';

export const AGENT_SCHEMA_VERSION = 1;

// ── Op types ───────────────────────────────────────────────────────────

export interface AgentOpBase {
  /** Optional caller-assigned id (echoed into diffs/journal). */
  id?: string;
  /** "auto" | "vid:pid" | device path — required, never guessed. */
  device_selector: string;
}

/** One keymap slot patch: `index` is the 0-based slot in the 128-entry u32 table. */
export interface KeymapPatchEntry {
  index: number;
  /** Raw u32 key value (normalised to a number by validation). */
  value: number;
}

export interface SetKeymapOp extends AgentOpBase {
  op: 'set_keymap';
  /** Keymap layer 0–3 (khub916 arg = layer | system<<2). */
  layer: number;
  /** System bit 0–1, default 0. */
  system?: number;
  /** Sparse slot patches — the executor read-modify-writes the rest. */
  entries: KeymapPatchEntry[];
}

export interface SetLightOp extends AgentOpBase {
  op: 'set_light';
  /**
   * `kb916 light apply`-style config — validated by
   * `safety/validation.ts::validateLightConfig`. `keys.preset` and
   * `keys.to` are rejected here: they have no wire mapping yet.
   */
  config: unknown;
}

/**
 * One macro step in the docs/macro-schema.md shape. `up: true|false` is
 * accepted as sugar for `action: "up"|"down"` and normalised before the
 * safety validator sees it.
 */
export interface MacroStepInput {
  action?: unknown;
  key?: unknown;
  code?: unknown;
  delay_ms?: unknown;
  duration?: unknown;
  kind?: unknown;
  up?: unknown;
  [k: string]: unknown;
}

export interface SetMacroOp extends AgentOpBase {
  op: 'set_macro';
  /** Entry name (≤255 bytes). Required for new macros. */
  name?: string;
  /** Position in the current macro region — alternative to `name`. */
  index?: number;
  /** Step array or `{name?, steps}` — validated by validateMacroSteps. */
  steps?: unknown;
  /** Remove the macro instead of writing it. Mutually exclusive with `steps`. */
  delete?: boolean;
  /** Keymap slot (0–127) to bind the macro to, on `bind_layer`. */
  bind_key?: number;
  /** Keymap layer for the bind, default 0. */
  bind_layer?: number;
  /** Vendor macro-type byte, default 1. */
  macro_type?: number;
  /** Vendor loop count, default 1. */
  loop?: number;
}

export type AdvMode = 'mt' | 'socd' | 'tgl';

/**
 * Advanced-key (SOCD/MT/TGL) bind — lowers to the vendor two-write path
 * (`writeKeyConfiguration` + `writeAdvKeyConfig`, proto/advkey916.ts).
 * `key`/`key_a`/`key_b`/`toggle` are keymap slot indices, or layout key
 * names resolved by the planner against `DeviceContext.layout`.
 * `tap`/`hold` are raw u32 key values (number or `0x…` hex).
 */
export interface SetAdvOp extends AgentOpBase {
  op: 'set_adv';
  mode: AdvMode;
  /** MT bind key / TGL bind key (index or layout name). */
  key?: number | string;
  /** SOCD key A / key B. */
  key_a?: number | string;
  key_b?: number | string;
  /** TGL: keymap index whose current value is stored. */
  toggle?: number | string;
  /** MT: u32 emitted on short press. */
  tap?: number | string;
  /** MT: u32 emitted on long press. */
  hold?: number | string;
  /** MT: hold threshold in ms (vendor stores 10 ms units). */
  hold_ms?: number;
  /** SOCD direction 0–3 (vendor socdList id). */
  direction?: number;
}

export const SNAPSHOT_SECTION_NAMES = ['keymap', 'lighting', 'macro', 'profile'] as const;

export interface RestoreSnapshotOp extends AgentOpBase {
  op: 'restore_snapshot';
  /** SnapshotStore id (`snap-…`). */
  id: string;
  /** Sections to restore; default = every section in the snapshot. */
  sections?: SnapshotSectionName[];
}

/** Profile sections with a proven write mapping (proto/khub916.ts). */
export type ProfileSectionName = 'sleep_seconds';

export interface SetProfileSectionOp extends AgentOpBase {
  op: 'set_profile_section';
  section: ProfileSectionName;
  value: number;
}

export type AgentOp =
  | SetKeymapOp
  | SetLightOp
  | SetMacroOp
  | SetAdvOp
  | RestoreSnapshotOp
  | SetProfileSectionOp;

export type AgentOpKind = AgentOp['op'];

export const AGENT_OP_KINDS: readonly AgentOpKind[] = [
  'set_keymap',
  'set_light',
  'set_macro',
  'set_adv',
  'restore_snapshot',
  'set_profile_section',
];

/** Plan request envelope (docs/AGENT-ARCHITECTURE.md §3). */
export interface AgentPlanRequest {
  schema_version?: number;
  device_selector?: string;
  ops: unknown[];
  meta?: { requested_by?: string; rationale?: string };
}

// ── Primitive helpers ──────────────────────────────────────────────────

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v);
}

const HEX_U32 = /^0x[0-9a-fA-F]{1,8}$/;

/** u32 from an integer or `0x…` hex string — the agent-facing value form. */
export function parseU32Value(v: unknown): number | null {
  if (isInt(v) && v >= 0 && v <= 0xffffffff) return v >>> 0;
  if (typeof v === 'string') {
    const t = v.trim();
    if (HEX_U32.test(t)) {
      const n = parseInt(t.slice(2), 16);
      return n <= 0xffffffff ? (n >>> 0) : null;
    }
  }
  return null;
}

function checkSelector(v: unknown, errors: string[]): v is string {
  if (typeof v !== 'string' || v.trim().length === 0) {
    errors.push('device_selector must be a non-empty string ("auto", "vid:pid" or a device path)');
    return false;
  }
  return true;
}

function optInt(
  obj: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
  errors: string[],
): number | undefined {
  const v = obj[key];
  if (v === undefined || v === null) return undefined;
  if (!isInt(v) || v < min || v > max) {
    errors.push(`${key} must be an integer ${min}..${max}, got ${JSON.stringify(v)}`);
    return undefined;
  }
  return v;
}

// ── Per-op validation ──────────────────────────────────────────────────

function validateSetKeymap(raw: Record<string, unknown>, errors: string[]): SetKeymapOp | null {
  const layer = optInt(raw, 'layer', 0, 3, errors);
  if (layer === undefined && raw.layer !== undefined) return null;
  if (raw.layer === undefined) errors.push('set_keymap: missing layer (0..3)');

  let system = 0;
  if (raw.system !== undefined && raw.system !== null) {
    const s = optInt(raw, 'system', 0, 1, errors);
    if (s === undefined) return null;
    system = s;
  }

  const entriesRaw = raw.entries;
  if (!Array.isArray(entriesRaw) || entriesRaw.length === 0) {
    errors.push('set_keymap: entries must be a non-empty array of {index, value}');
    return null;
  }
  if (entriesRaw.length > KEYMAP_ENTRIES) {
    errors.push(`set_keymap: ${entriesRaw.length} entries — cap is ${KEYMAP_ENTRIES}`);
  }
  const entries: KeymapPatchEntry[] = [];
  const seen = new Set<number>();
  let bad = false;
  entriesRaw.forEach((e, i) => {
    const ctx = `entries[${i}]`;
    if (!isObj(e)) {
      errors.push(`set_keymap ${ctx}: must be an object {index, value}`);
      bad = true;
      return;
    }
    const index = e.index;
    if (!isInt(index) || index < 0 || index >= KEYMAP_ENTRIES) {
      errors.push(`set_keymap ${ctx}: index must be an integer 0..${KEYMAP_ENTRIES - 1}`);
      bad = true;
      return;
    }
    if (seen.has(index)) {
      errors.push(`set_keymap ${ctx}: duplicate index ${index}`);
      bad = true;
      return;
    }
    seen.add(index);
    const value = parseU32Value(e.value);
    if (value === null) {
      errors.push(
        `set_keymap ${ctx}: value must be a u32 (integer or 0x… hex), got ${JSON.stringify(e.value)}`,
      );
      bad = true;
      return;
    }
    entries.push({ index, value });
  });
  if (bad || layer === undefined) return null;
  return {
    op: 'set_keymap',
    device_selector: raw.device_selector as string,
    ...(typeof raw.id === 'string' ? { id: raw.id } : {}),
    layer,
    system,
    entries,
  };
}

function validateSetLight(raw: Record<string, unknown>, errors: string[]): SetLightOp | null {
  const config = raw.config;
  if (config === undefined) {
    errors.push('set_light: missing config');
    return null;
  }
  // Reuse the safety-layer light-config validator (docs/lighting-schema.md).
  const v = validateLightConfig(config);
  for (const e of v.errors) errors.push(`set_light config: ${e}`);
  // Fields the wire cannot express yet — reject rather than silently drop.
  if (isObj(config)) {
    const keys = config.keys;
    if (isObj(keys)) {
      if (keys.preset !== undefined) {
        errors.push('set_light config: keys.preset has no device write mapping yet');
      }
      if (keys.to !== undefined) {
        errors.push('set_light config: keys.to (gradient target) has no device write mapping yet');
      }
    }
  }
  if (errors.length > 0) return null;
  return {
    op: 'set_light',
    device_selector: raw.device_selector as string,
    ...(typeof raw.id === 'string' ? { id: raw.id } : {}),
    config,
  };
}

/** Normalise `up: bool` → `action` and bare letters → vendor `KeyX` names. */
function normalizeMacroSteps(steps: unknown): unknown {
  const arr = Array.isArray(steps) ? steps : isObj(steps) ? steps.steps : steps;
  if (!Array.isArray(arr)) return steps;
  const mapStep = (s: unknown): unknown => {
    if (!isObj(s)) return s;
    const out: Record<string, unknown> = { ...s };
    if (out.action === undefined && typeof out.up === 'boolean') {
      out.action = out.up ? 'up' : 'down';
    }
    delete out.up;
    if (
      typeof out.key === 'string' &&
      /^[a-zA-Z]$/.test(out.key) &&
      out.action !== undefined
    ) {
      out.key = `Key${out.key.toUpperCase()}`;
    }
    return out;
  };
  const mapped = arr.map(mapStep);
  if (isObj(steps) && 'steps' in steps) {
    return { ...steps, steps: mapped };
  }
  return mapped;
}

function validateSetMacro(raw: Record<string, unknown>, errors: string[]): SetMacroOp | null {
  const hasDelete = raw.delete === true;
  const hasSteps = raw.steps !== undefined && raw.steps !== null;
  if (hasDelete && hasSteps) {
    errors.push('set_macro: delete and steps are mutually exclusive');
    return null;
  }
  if (!hasDelete && !hasSteps) {
    errors.push('set_macro: give steps to write, or delete:true to remove');
    return null;
  }
  if (raw.delete !== undefined && typeof raw.delete !== 'boolean') {
    errors.push('set_macro: delete must be a boolean');
    return null;
  }

  let name: string | undefined;
  if (raw.name !== undefined && raw.name !== null) {
    if (typeof raw.name !== 'string') {
      errors.push('set_macro: name must be a string');
      return null;
    }
    if (new TextEncoder().encode(raw.name).length > 255) {
      errors.push('set_macro: name exceeds the 255-byte wire limit');
      return null;
    }
    name = raw.name;
  }
  if (!hasDelete && name === undefined && raw.index === undefined) {
    errors.push('set_macro: a new macro needs a name (or an index to replace)');
    return null;
  }
  if (hasDelete && name === undefined && raw.index === undefined) {
    errors.push('set_macro delete: name a macro by name or index');
    return null;
  }

  const index = optInt(raw, 'index', 0, MAX_MACRO_STEPS * 4, errors);
  const bindKey = optInt(raw, 'bind_key', 0, KEYMAP_ENTRIES - 1, errors);
  const bindLayer = optInt(raw, 'bind_layer', 0, 3, errors);
  const macroType = optInt(raw, 'macro_type', 0, 0xff, errors);
  const loop = optInt(raw, 'loop', 0, 0xff, errors);
  if (hasDelete && bindKey !== undefined) {
    errors.push('set_macro: bind_key makes no sense with delete');
  }
  if (errors.length > 0) return null;

  let steps: unknown;
  if (hasSteps) {
    steps = normalizeMacroSteps(raw.steps);
    const v = validateMacroSteps(steps);
    for (const e of v.errors) errors.push(`set_macro steps: ${e}`);
    if (!v.ok) return null;
  }

  return {
    op: 'set_macro',
    device_selector: raw.device_selector as string,
    ...(typeof raw.id === 'string' ? { id: raw.id } : {}),
    ...(name !== undefined ? { name } : {}),
    ...(index !== undefined ? { index } : {}),
    ...(steps !== undefined ? { steps } : {}),
    ...(hasDelete ? { delete: true } : {}),
    ...(bindKey !== undefined ? { bind_key: bindKey } : {}),
    ...(bindLayer !== undefined ? { bind_layer: bindLayer } : {}),
    ...(macroType !== undefined ? { macro_type: macroType } : {}),
    ...(loop !== undefined ? { loop } : {}),
  };
}

function keyRefOk(v: unknown, what: string, errors: string[]): boolean {
  if (typeof v === 'number') {
    if (!isInt(v) || v < 0 || v >= KEYMAP_ENTRIES) {
      errors.push(`set_adv ${what}: keymap index must be an integer 0..${KEYMAP_ENTRIES - 1}`);
      return false;
    }
    return true;
  }
  if (typeof v === 'string' && v.trim().length > 0) return true; // layout name — planner resolves
  errors.push(`set_adv ${what}: must be a keymap index or a layout key name`);
  return false;
}

function validateSetAdv(raw: Record<string, unknown>, errors: string[]): SetAdvOp | null {
  const mode = raw.mode;
  if (mode !== 'mt' && mode !== 'socd' && mode !== 'tgl') {
    errors.push(`set_adv: mode must be mt|socd|tgl, got ${JSON.stringify(mode)}`);
    return null;
  }

  let ok = true;
  const out: Record<string, unknown> = {
    op: 'set_adv',
    device_selector: raw.device_selector,
    mode,
  };
  if (typeof raw.id === 'string') out.id = raw.id;

  if (mode === 'mt') {
    if (raw.key === undefined) {
      errors.push('set_adv mt: missing bind key');
      ok = false;
    } else if (!keyRefOk(raw.key, 'key', errors)) ok = false;
    else out.key = raw.key;
    const tap = parseU32Value(raw.tap);
    const hold = parseU32Value(raw.hold);
    if (tap === null) {
      errors.push('set_adv mt: tap must be a u32 key value (integer or 0x… hex)');
      ok = false;
    } else out.tap = tap;
    if (hold === null) {
      errors.push('set_adv mt: hold must be a u32 key value (integer or 0x… hex)');
      ok = false;
    } else out.hold = hold;
    if (raw.hold_ms !== undefined) {
      if (!isInt(raw.hold_ms) || (raw.hold_ms as number) < 0 || (raw.hold_ms as number) > 0xffff * 10) {
        errors.push('set_adv mt: hold_ms must be an integer 0..655350 (10 ms units × 65535)');
        ok = false;
      } else out.hold_ms = raw.hold_ms;
    }
  } else if (mode === 'socd') {
    for (const k of ['key_a', 'key_b'] as const) {
      if (raw[k] === undefined) {
        errors.push(`set_adv socd: missing ${k}`);
        ok = false;
      } else if (!keyRefOk(raw[k], k, errors)) ok = false;
      else out[k] = raw[k];
    }
    const dir = optInt(raw, 'direction', 0, 3, errors);
    if (raw.direction !== undefined && dir === undefined) ok = false;
    if (dir !== undefined) out.direction = dir;
  } else {
    // tgl
    if (raw.key === undefined) {
      errors.push('set_adv tgl: missing bind key');
      ok = false;
    } else if (!keyRefOk(raw.key, 'key', errors)) ok = false;
    else out.key = raw.key;
    if (raw.toggle === undefined) {
      errors.push('set_adv tgl: missing toggle key');
      ok = false;
    } else if (!keyRefOk(raw.toggle, 'toggle', errors)) ok = false;
    else out.toggle = raw.toggle;
  }
  if (!ok || errors.length > 0) return null;
  return out as unknown as SetAdvOp;
}

function validateRestoreSnapshot(
  raw: Record<string, unknown>,
  errors: string[],
): RestoreSnapshotOp | null {
  if (typeof raw.id !== 'string' || raw.id.trim().length === 0) {
    errors.push('restore_snapshot: id must be a non-empty snapshot id');
    return null;
  }
  let sections: SnapshotSectionName[] | undefined;
  if (raw.sections !== undefined) {
    if (
      !Array.isArray(raw.sections) ||
      raw.sections.some((s) => !SNAPSHOT_SECTION_NAMES.includes(s as SnapshotSectionName))
    ) {
      errors.push(
        `restore_snapshot: sections must be a subset of ${SNAPSHOT_SECTION_NAMES.join('|')}`,
      );
      return null;
    }
    sections = raw.sections as SnapshotSectionName[];
  }
  return {
    op: 'restore_snapshot',
    device_selector: raw.device_selector as string,
    id: raw.id as string,
    ...(sections !== undefined ? { sections } : {}),
  };
}

function validateSetProfileSection(
  raw: Record<string, unknown>,
  errors: string[],
): SetProfileSectionOp | null {
  if (raw.section !== 'sleep_seconds') {
    errors.push(
      `set_profile_section: unsupported section ${JSON.stringify(raw.section)} (want sleep_seconds)`,
    );
    return null;
  }
  if (!isInt(raw.value) || (raw.value as number) < 0 || (raw.value as number) > 255) {
    errors.push('set_profile_section: value must be an integer 0..255');
    return null;
  }
  return {
    op: 'set_profile_section',
    device_selector: raw.device_selector as string,
    ...(typeof raw.id === 'string' ? { id: raw.id } : {}),
    section: 'sleep_seconds',
    value: raw.value as number,
  };
}

// ── Public API ─────────────────────────────────────────────────────────

/**
 * Validate one raw op. Returns `{ ok, errors }` plus the NORMALISED op
 * (`op` field) when it passes — values are u32 numbers, macro steps are
 * in schema shape, `up:` sugar already folded into `action`.
 */
export function validateOp(input: unknown): ValidationResult & { op?: AgentOp } {
  const errors: string[] = [];
  if (!isObj(input)) {
    return { ok: false, errors: ['op must be a JSON object'] };
  }
  const kind = input.op;
  if (typeof kind !== 'string' || !AGENT_OP_KINDS.includes(kind as AgentOpKind)) {
    errors.push(
      `unknown op ${JSON.stringify(kind)} — want one of ${AGENT_OP_KINDS.join(', ')}`,
    );
    return { ok: false, errors };
  }
  if (!checkSelector(input.device_selector, errors)) {
    return { ok: false, errors };
  }

  let op: AgentOp | null = null;
  switch (kind as AgentOpKind) {
    case 'set_keymap':
      op = validateSetKeymap(input, errors);
      break;
    case 'set_light':
      op = validateSetLight(input, errors);
      break;
    case 'set_macro':
      op = validateSetMacro(input, errors);
      break;
    case 'set_adv':
      op = validateSetAdv(input, errors);
      break;
    case 'restore_snapshot':
      op = validateRestoreSnapshot(input, errors);
      break;
    case 'set_profile_section':
      op = validateSetProfileSection(input, errors);
      break;
  }
  const ok = errors.length === 0 && op !== null;
  return { ok, errors, ...(op !== null ? { op } : {}) };
}

/**
 * Validate a plan request: `{schema_version?, device_selector?, ops[]}`
 * or a bare ops array. schema_version must be 1 when present; every op
 * goes through `validateOp`. Returns `{ ok, errors, ops }` where `ops`
 * is the normalised op list (only fully valid ops are included).
 */
export function validatePlan(
  input: unknown,
): ValidationResult & { ops?: AgentOp[] } {
  const errors: string[] = [];
  let rawOps: unknown;
  if (Array.isArray(input)) {
    rawOps = input;
  } else if (isObj(input)) {
    if (input.schema_version !== undefined && input.schema_version !== AGENT_SCHEMA_VERSION) {
      errors.push(
        `unsupported schema_version ${JSON.stringify(input.schema_version)} (want ${AGENT_SCHEMA_VERSION})`,
      );
    }
    rawOps = input.ops;
  } else {
    return { ok: false, errors: ['plan must be an object {ops:[…]} or an ops array'] };
  }
  if (!Array.isArray(rawOps) || rawOps.length === 0) {
    errors.push('plan ops must be a non-empty array');
    return { ok: false, errors };
  }
  if (rawOps.length > 64) {
    errors.push(`plan has ${rawOps.length} ops — cap is 64`);
  }
  const ops: AgentOp[] = [];
  rawOps.forEach((raw, i) => {
    const v = validateOp(raw);
    for (const e of v.errors) errors.push(`ops[${i}]: ${e}`);
    if (v.op) ops.push(v.op);
  });
  return { ok: errors.length === 0, errors, ops };
}
