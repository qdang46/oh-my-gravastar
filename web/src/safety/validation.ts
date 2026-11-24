/**
 * Input validation for the khub916 safety layer (vision-full-custom.md §4,
 * layer 1 — input validation).
 *
 * Every validator returns `{ ok, errors }` and NEVER throws: callers get a
 * full list of problems to show the user before anything reaches the wire.
 * The checks mirror the existing parse/apply paths —
 * `pages-secondary.ts::parseProfileImport` (schema-v1 backup shape),
 * `proto/macro916.ts::parseStepsJson` (macro step schema,
 * docs/macro-schema.md) and `kb916_light.rs`/docs/lighting-schema.md
 * (lighting apply config) — but collect *all* errors instead of stopping
 * at the first one, and enforce the size caps the write paths rely on
 * (128 keymap u32 slots, 126 light colours, 512-byte macro region,
 * 506-byte light-data blob, 512-byte profile blob).
 */

import { FEATURE_PAYLOAD_BYTES, HEADER_LEN, KEYMAP_ENTRIES } from '../proto/khub916.ts';
import { CUSTOM_LIGHT_SLOTS, LIGHT_DATA_MAX, parseColor } from '../proto/light.ts';
import {
  MACRO_KEY_TABLE,
  MACRO_REGION_BYTES,
  MAX_STEP_DURATION,
  macroUsageForName,
} from '../proto/macro916.ts';

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

function result(errors: string[]): ValidationResult {
  return { ok: errors.length === 0, errors };
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v);
}

// ── Primitive parsers (mirroring pages-secondary.ts) ───────────────────

const HEX_U32 = /^0x[0-9a-fA-F]{8}$/;
const HEX_ANY = /^[0-9a-fA-F]*$/;

/** Profile-export keymap value: `"0x........"` string or u32 integer. */
function parseU32(v: unknown): number | null {
  if (typeof v === 'string' && HEX_U32.test(v)) {
    return parseInt(v.slice(2), 16) >>> 0;
  }
  if (isInt(v) && v >= 0 && v <= 0xffffffff) {
    return v >>> 0;
  }
  return null;
}

/** Even-length hex string → bytes, or null. */
export function hexToBytes(hex: string): Uint8Array | null {
  const h = hex.trim();
  if (h.length === 0 || h.length % 2 !== 0 || !HEX_ANY.test(h)) return null;
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToHex(b: Uint8Array): string {
  let s = '';
  for (const x of b) s += x.toString(16).padStart(2, '0');
  return s;
}

// ── Keymap ─────────────────────────────────────────────────────────────

export const KEYMAP_ARG_MAX = 7; // args 0–7 = layer | system<<2 (khub916_state)

/**
 * One keymap set: `{ arg, values }` where `arg` is the packed
 * layer|system keymap channel (0–7) and `values` is 1..128 u32 key
 * values (`"0x........"` strings or integers, matching
 * `parseProfileImport`). Returns all problems found.
 */
export function validateKeymapEntry(entry: unknown): ValidationResult {
  const errors: string[] = [];
  if (!isObj(entry)) {
    return result(['keymap entry must be an object { arg, values }']);
  }
  const arg = entry.arg;
  if (!isInt(arg) || arg < 0 || arg > KEYMAP_ARG_MAX) {
    errors.push(`keymap arg must be an integer 0..${KEYMAP_ARG_MAX}, got ${JSON.stringify(arg)}`);
  }
  const values = entry.values;
  if (!Array.isArray(values) || values.length === 0) {
    errors.push('keymap values must be a non-empty array');
  } else {
    if (values.length > KEYMAP_ENTRIES) {
      errors.push(
        `keymap has ${values.length} values — the wire table holds at most ${KEYMAP_ENTRIES}`,
      );
    }
    values.forEach((v, i) => {
      if (parseU32(v) === null) {
        errors.push(
          `keymap value ${i} is not a u32 (want 0x........ hex or an integer 0..4294967295): ${JSON.stringify(v)}`,
        );
      }
    });
  }
  return result(errors);
}

/**
 * Validate a `{ "<arg>": [values…] }` keymap object (the `state.keymap`
 * shape from `buildProfileExport`). Returns `{ ok, errors, values }`
 * where `values` maps arg → parsed u32 list when ok.
 */
export function validateKeymapSection(
  keymap: unknown,
): ValidationResult & { values?: Record<number, number[]> } {
  const errors: string[] = [];
  const values: Record<number, number[]> = {};
  if (!isObj(keymap)) {
    return { ...result(['keymap must be an object keyed by arg']), values };
  }
  const keys = Object.keys(keymap);
  if (keys.length > KEYMAP_ARG_MAX + 1) {
    errors.push(`keymap has ${keys.length} sets — at most ${KEYMAP_ARG_MAX + 1} (args 0–7)`);
  }
  for (const [argStr, raw] of Object.entries(keymap)) {
    const arg = Number(argStr);
    if (!Number.isInteger(arg) || arg < 0 || arg > KEYMAP_ARG_MAX) {
      errors.push(`keymap arg '${argStr}' is not an integer 0..${KEYMAP_ARG_MAX}`);
      continue;
    }
    const entry = validateKeymapEntry({ arg, values: raw });
    for (const e of entry.errors) errors.push(`keymap set ${argStr}: ${e}`);
    if (entry.ok && Array.isArray(raw)) {
      values[arg] = raw.map((v) => parseU32(v) as number);
    }
  }
  return { ...result(errors), values: errors.length === 0 ? values : undefined };
}

// ── Macro steps (docs/macro-schema.md, proto/macro916.ts) ─────────────

const MACRO_ACTIONS = new Set(['down', 'up', 'press', 'release', 'keydown', 'keyup', '0', '1']);
const MACRO_KINDS = new Set(['key', 'modifier', 'mod', 'mouse']);
/** Generous cap: a 512-byte region cannot hold more than ~120 steps anyway. */
export const MAX_MACRO_STEPS = 512;

/** Resolve a macro `key` field to a u8 usage, or null. Mirrors parseKey. */
function resolveMacroKey(v: unknown): number | null {
  if (typeof v === 'string') {
    const t = v.trim();
    const hex = t.startsWith('0x') || t.startsWith('0X') ? t.slice(2) : null;
    if (hex !== null) {
      if (!/^[0-9a-fA-F]+$/.test(hex)) return null;
      const n = parseInt(hex, 16);
      return n <= 0xff ? n : null;
    }
    if (/^\d+$/.test(t)) {
      const n = parseInt(t, 10);
      return n <= 0xff ? n : null;
    }
    let usage = macroUsageForName(t);
    if (usage === null) {
      const lower = t.toLowerCase();
      for (const [n2, u] of MACRO_KEY_TABLE) {
        if (n2.toLowerCase() === lower) {
          usage = u;
          break;
        }
      }
    }
    return usage !== null && usage <= 0xff ? usage : null;
  }
  if (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 0xff) return v;
  return null;
}

function validateOneStep(v: unknown, i: number, errors: string[]): void {
  const ctx = `steps[${i}]`;
  if (!isObj(v)) {
    errors.push(`${ctx}: step must be an object`);
    return;
  }
  const action = v.action;
  const actionOk =
    (typeof action === 'string' && MACRO_ACTIONS.has(action.toLowerCase())) ||
    (isInt(action) && (action === 0 || action === 1));
  if (!('action' in v)) {
    errors.push(`${ctx}: missing 'action'`);
  } else if (!actionOk) {
    errors.push(`${ctx}: bad action ${JSON.stringify(action)} (want down|up)`);
  }
  const keyV = 'key' in v ? v.key : 'code' in v ? v.code : undefined;
  if (keyV === undefined) {
    errors.push(`${ctx}: missing 'key'`);
  } else if (resolveMacroKey(keyV) === null) {
    errors.push(
      `${ctx}: bad key ${JSON.stringify(keyV)} (want a vendor key name like KeyA/ShiftLeft/MouseLeft, a usage 0-255, or 0x hex)`,
    );
  }
  const delayV = 'delay_ms' in v ? v.delay_ms : 'duration' in v ? v.duration : undefined;
  if (delayV !== undefined && delayV !== null) {
    if (!isInt(delayV) || delayV < 0) {
      errors.push(`${ctx}: delay_ms must be a non-negative integer`);
    } else if (delayV > MAX_STEP_DURATION) {
      errors.push(`${ctx}: delay_ms ${delayV} exceeds the 20-bit wire max ${MAX_STEP_DURATION}`);
    }
  }
  const kind = v.kind;
  if (kind !== undefined && kind !== null) {
    if (typeof kind !== 'string' || !MACRO_KINDS.has(kind.toLowerCase())) {
      errors.push(`${ctx}: bad kind ${JSON.stringify(kind)} (want key|modifier|mouse)`);
    }
  }
}

/**
 * Validate a macro steps payload: bare step array or
 * `{ name?, steps: [...] }` (docs/macro-schema.md). Accepts a JSON string
 * or an already-parsed value. Collects every problem found.
 */
export function validateMacroSteps(input: unknown): ValidationResult {
  const errors: string[] = [];
  let v = input;
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v);
    } catch (e) {
      return result([`steps JSON parse error: ${e instanceof Error ? e.message : String(e)}`]);
    }
  }
  let name: unknown;
  let arr: unknown;
  if (Array.isArray(v)) {
    arr = v;
  } else if (isObj(v)) {
    name = v.name;
    arr = 'steps' in v ? v.steps : 'data' in v ? v.data : undefined;
    if (arr === undefined) errors.push("steps object needs a 'steps' array");
  } else {
    return result(['steps JSON must be an array or an object with \'steps\'']);
  }
  if (name !== undefined && name !== null && typeof name !== 'string') {
    errors.push('macro name must be a string');
  } else if (typeof name === 'string' && new TextEncoder().encode(name).length > 255) {
    errors.push('macro name exceeds the 255-byte wire limit');
  }
  if (!Array.isArray(arr)) {
    if (arr !== undefined) errors.push('steps must be an array');
    return result(errors);
  }
  if (arr.length === 0) {
    errors.push('steps array is empty — to delete a macro remove it from the list instead');
  }
  if (arr.length > MAX_MACRO_STEPS) {
    errors.push(`steps has ${arr.length} entries — cap is ${MAX_MACRO_STEPS}`);
  }
  // Rough wire-size sanity: name + 4 B/step must fit the 512 B region
  // when this macro is the only content (upper bound, not exact).
  const nameBytes = typeof name === 'string' ? new TextEncoder().encode(name).length + 1 : 0;
  if (nameBytes + arr.length * 4 > MACRO_REGION_BYTES) {
    errors.push(
      `macro needs ~${nameBytes + arr.length * 4} region bytes — over the ${MACRO_REGION_BYTES}-byte cap`,
    );
  }
  arr.forEach((s, i) => validateOneStep(s, i, errors));
  return result(errors);
}

// ── Lighting config (docs/lighting-schema.md, kb916_light.rs) ─────────

const LIGHT_PRESETS = new Set(['solid', 'gradient', 'rainbow']);
const COLOR_INDEX_MAX = CUSTOM_LIGHT_SLOTS - 1; // 0..125

function checkColor(v: unknown, what: string, errors: string[]): void {
  try {
    parseColor(v, what);
  } catch (e) {
    errors.push(e instanceof Error ? e.message : String(e));
  }
}

/**
 * Validate a `kb916 light apply`-style JSON config
 * (`{schema:1, mode, speed, brightness, color_model, color, keys}`).
 * Every field optional; at least one must be present. Collects all errors.
 */
export function validateLightConfig(input: unknown): ValidationResult {
  const errors: string[] = [];
  let v = input;
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v);
    } catch (e) {
      return result([`light config JSON parse error: ${e instanceof Error ? e.message : String(e)}`]);
    }
  }
  if (!isObj(v)) {
    return result(['light config must be a JSON object']);
  }
  if ('schema' in v && v.schema !== 1) {
    errors.push(`unsupported light config schema ${JSON.stringify(v.schema)} (want 1)`);
  }
  const hasField = ['mode', 'speed', 'brightness', 'color_model', 'color', 'keys'].some(
    (k) => v[k] !== undefined,
  );
  if (!hasField) {
    errors.push('light config sets nothing — give at least one of mode/speed/brightness/color_model/color/keys');
  }
  if (v.mode !== undefined && (!isInt(v.mode) || v.mode < 0 || v.mode > 0xffff)) {
    errors.push(`mode must be an integer 0..65535, got ${JSON.stringify(v.mode)}`);
  }
  for (const k of ['speed', 'brightness'] as const) {
    if (v[k] !== undefined && (!isInt(v[k]) || (v[k] as number) < 0 || (v[k] as number) > 20)) {
      errors.push(`${k} must be an integer 0..20 (vendor limit), got ${JSON.stringify(v[k])}`);
    }
  }
  if (
    v.color_model !== undefined &&
    (!isInt(v.color_model) || (v.color_model as number) < 1 || (v.color_model as number) > 2)
  ) {
    errors.push(`color_model must be 1 (monochrome) or 2 (mixing), got ${JSON.stringify(v.color_model)}`);
  }
  if (v.color !== undefined) checkColor(v.color, 'color', errors);

  const keys = v.keys;
  if (keys !== undefined) {
    if (!isObj(keys)) {
      errors.push('keys must be an object');
    } else {
      if (keys.preset !== undefined) {
        if (typeof keys.preset !== 'string' || !LIGHT_PRESETS.has(keys.preset)) {
          errors.push(`keys.preset must be one of solid|gradient|rainbow, got ${JSON.stringify(keys.preset)}`);
        }
      }
      if (keys.color !== undefined) checkColor(keys.color, 'keys.color', errors);
      if (keys.to !== undefined) checkColor(keys.to, 'keys.to', errors);
      if (keys.colors !== undefined) {
        if (!Array.isArray(keys.colors)) {
          errors.push('keys.colors must be an array of colours');
        } else if (keys.colors.length !== CUSTOM_LIGHT_SLOTS) {
          errors.push(
            `keys.colors must contain exactly ${CUSTOM_LIGHT_SLOTS} colours, got ${keys.colors.length}`,
          );
        } else {
          keys.colors.forEach((c, i) => checkColor(c, `keys.colors[${i}]`, errors));
        }
      }
      if (keys.entries !== undefined) {
        if (!Array.isArray(keys.entries)) {
          errors.push('keys.entries must be an array');
        } else {
          if (keys.entries.length > COLOR_INDEX_MAX + 1) {
            errors.push(`keys.entries has ${keys.entries.length} entries — cap is ${COLOR_INDEX_MAX + 1}`);
          }
          const seen = new Set<number>();
          keys.entries.forEach((e, i) => {
            const ctx = `keys.entries[${i}]`;
            if (!isObj(e)) {
              errors.push(`${ctx}: entry must be an object`);
              return;
            }
            const idx = e.index ?? e.pos;
            if (!isInt(idx) || idx < 0 || idx > COLOR_INDEX_MAX) {
              errors.push(`${ctx}: index/pos must be an integer 0..${COLOR_INDEX_MAX}, got ${JSON.stringify(idx)}`);
            } else if (seen.has(idx)) {
              errors.push(`${ctx}: duplicate colour index ${idx}`);
            } else {
              seen.add(idx);
            }
            if (!('color' in e)) {
              errors.push(`${ctx}: missing 'color'`);
            } else {
              checkColor(e.color, `${ctx}.color`, errors);
            }
          });
        }
      }
    }
  }
  return result(errors);
}

// ── Profile backup (schema v1, pages-secondary.ts buildProfileExport) ──

const PROFILE_HEX_MAX_BYTES = FEATURE_PAYLOAD_BYTES - HEADER_LEN; // 512
const MAX_DEVICES = 16;
const MAX_PROFILES = 16;

function checkHexField(
  obj: Record<string, unknown>,
  key: string,
  maxBytes: number,
  errors: string[],
  path: string,
): void {
  const v = obj[key];
  if (v === undefined || v === null) return;
  if (typeof v !== 'string') {
    errors.push(`${path}.${key} must be a hex string`);
    return;
  }
  const bytes = hexToBytes(v);
  if (bytes === null) {
    errors.push(`${path}.${key} is not valid hex`);
  } else if (bytes.length > maxBytes) {
    errors.push(`${path}.${key} is ${bytes.length} bytes — cap is ${maxBytes}`);
  } else if (bytes.length === 0 && v.length > 0) {
    errors.push(`${path}.${key} decoded to zero bytes`);
  }
}

/** Per-key colour entries: `{index, pos?, r, g, b}` — index unique 0..125. */
function validateLightColors(colors: unknown, path: string, errors: string[]): void {
  if (!Array.isArray(colors)) {
    errors.push(`${path}.light_colors must be an array`);
    return;
  }
  if (colors.length > CUSTOM_LIGHT_SLOTS) {
    errors.push(`${path}.light_colors has ${colors.length} entries — cap is ${CUSTOM_LIGHT_SLOTS}`);
  }
  const seen = new Set<number>();
  colors.forEach((e, i) => {
    const ctx = `${path}.light_colors[${i}]`;
    if (!isObj(e)) {
      errors.push(`${ctx}: entry must be an object`);
      return;
    }
    const idx = e.index;
    if (!isInt(idx) || idx < 0 || idx > COLOR_INDEX_MAX) {
      errors.push(`${ctx}: index must be an integer 0..${COLOR_INDEX_MAX}, got ${JSON.stringify(idx)}`);
    } else if (seen.has(idx)) {
      errors.push(`${ctx}: duplicate colour index ${idx}`);
    } else {
      seen.add(idx);
    }
    if (e.pos !== undefined && (!isInt(e.pos) || (e.pos as number) < 0)) {
      errors.push(`${ctx}: pos must be a non-negative integer`);
    }
    for (const ch of ['r', 'g', 'b'] as const) {
      const c = e[ch];
      if (!isInt(c) || c < 0 || c > 255) {
        errors.push(`${ctx}: ${ch} must be an integer 0..255, got ${JSON.stringify(c)}`);
      }
    }
  });
}

/** Deep checks on a khub916 `state` object (shape from buildProfileExport). */
function validateKhub916State(state: Record<string, unknown>, path: string, errors: string[]): void {
  if ('keymap' in state && state.keymap !== undefined) {
    const km = validateKeymapSection(state.keymap);
    for (const e of km.errors) errors.push(`${path}.keymap: ${e}`);
  }
  if ('light_colors' in state && state.light_colors !== undefined) {
    validateLightColors(state.light_colors, path, errors);
  }
  checkHexField(state, 'light_data_hex', LIGHT_DATA_MAX, errors, path);
  checkHexField(state, 'macro_hex', MACRO_REGION_BYTES, errors, path);
  const profile = state.profile;
  if (profile !== undefined && profile !== null) {
    if (!isObj(profile)) {
      errors.push(`${path}.profile must be an object`);
    } else {
      checkHexField(profile, 'hex', PROFILE_HEX_MAX_BYTES, errors, `${path}.profile`);
      if (profile.light_mode !== undefined && profile.light_mode !== null) {
        const m = profile.light_mode;
        if (!isInt(m) || m < 0 || m > 0xffff) {
          errors.push(`${path}.profile.light_mode must be an integer 0..65535`);
        }
      }
      if (profile.sleep_seconds !== undefined && profile.sleep_seconds !== null) {
        const s = profile.sleep_seconds;
        if (!isInt(s) || s < 0 || s > 255) {
          errors.push(`${path}.profile.sleep_seconds must be an integer 0..255`);
        }
      }
    }
  }
  const power = state.power;
  if (power !== undefined && power !== null) {
    if (!isObj(power)) {
      errors.push(`${path}.power must be an object`);
    } else {
      if (power.percent !== undefined && (!isInt(power.percent) || (power.percent as number) < 0 || (power.percent as number) > 100)) {
        errors.push(`${path}.power.percent must be an integer 0..100`);
      }
      if (power.flags !== undefined && !isInt(power.flags)) {
        errors.push(`${path}.power.flags must be an integer`);
      }
    }
  }
}

/**
 * Validate a schema-v1 profile backup document — the same shape
 * `pages-secondary.ts::buildProfileExport` produces and
 * `parseProfileImport` consumes (aligns with `omg profile export|import`
 * and `crates/omg/src/profile.rs::validate_profile`, plus the deeper
 * khub916 section checks the web import lacked: u32 bounds, colour-index
 * duplicates, hex size caps).
 *
 * Accepts a JSON string or a parsed value. Never throws.
 */
export function validateProfileJson(input: unknown): ValidationResult {
  const errors: string[] = [];
  let doc = input;
  if (typeof doc === 'string') {
    try {
      doc = JSON.parse(doc);
    } catch (e) {
      return result([`profile file: invalid JSON: ${e instanceof Error ? e.message : String(e)}`]);
    }
  }
  if (!isObj(doc)) {
    return result(['profile file: top level must be a JSON object']);
  }
  if (doc.schema !== 1) {
    errors.push(`profile file: unsupported schema ${JSON.stringify(doc.schema)} (want 1)`);
  }
  const devices = doc.devices;
  if (!Array.isArray(devices) || devices.length === 0) {
    errors.push('profile file: missing or empty "devices" array');
    return result(errors);
  }
  if (devices.length > MAX_DEVICES) {
    errors.push(`profile file: ${devices.length} devices — cap is ${MAX_DEVICES}`);
  }
  devices.forEach((d, i) => {
    const path = `devices[${i}]`;
    if (!isObj(d)) {
      errors.push(`${path}: device must be an object`);
      return;
    }
    const protocol = d.protocol;
    if (typeof protocol !== 'string' || protocol.length === 0) {
      errors.push(`${path}: missing "protocol" string`);
    }
    for (const key of ['vid', 'pid'] as const) {
      const n = d[key];
      if (!isInt(n) || n < 0 || n > 0xffff) {
        errors.push(`${path}: '${key}' must be an integer 0..65535`);
      }
    }
    if (d.usage_page !== undefined && d.usage_page !== null) {
      const n = d.usage_page;
      if (!isInt(n) || n < 0 || n > 0xffff) {
        errors.push(`${path}: 'usage_page' must be an integer 0..65535`);
      }
    }
    if (d.profiles !== undefined && d.profiles !== null) {
      if (!Array.isArray(d.profiles)) {
        errors.push(`${path}: 'profiles' must be an array`);
      } else {
        if (d.profiles.length > MAX_PROFILES) {
          errors.push(`${path}: ${d.profiles.length} profiles — cap is ${MAX_PROFILES}`);
        }
        d.profiles.forEach((p, j) => {
          const ppath = `${path}.profiles[${j}]`;
          if (!isObj(p) || !isObj(p.state)) {
            errors.push(`${ppath}: missing object "state"`);
            return;
          }
          if (protocol === 'khub916') {
            validateKhub916State(p.state, ppath, errors);
          }
        });
      }
    }
  });
  return result(errors);
}

/** Convenience: bytes → hex for snapshot/profile storage. */
export function toHex(b: Uint8Array): string {
  return bytesToHex(b);
}
