/**
 * Preset library (bead mja) — built-in + user-saved presets for
 * lighting scenes and keymaps.
 *
 * A preset is a named, reusable config:
 * - `kind: 'lighting'` → `config` is a `LightingSceneConfig` (the
 *   `omg kb916 light apply` shape, validated by `parseSceneConfig`);
 * - `kind: 'keymap'`   → `config` is a `KeymapSnippetConfig`: a small
 *   set of layer-0 slot bindings (`keymap index → u32 value`). These
 *   are EXPERIMENTAL — they stage values on the K1 Pro layout's slot
 *   indices and have not been applied to hardware yet.
 *
 * Every preset declares a `target` (protocol / catalog models /
 * feature ids) so pages can warn before offering it; compatibility
 * checks reuse `core/compatibility.ts` (`canApplyProfile`) — cheap,
 * read-only, no device access.
 *
 * User presets persist in `localStorage` under `omg.presets.v1` and
 * round-trip through a self-describing `.json` file format
 * (`omg_preset: 1`). Built-ins are immutable: rename/delete/import
 * always produce user presets (`user-*` ids).
 *
 * DOM-free so `scripts/smoke-presets.ts` exercises it under plain Node;
 * only the storage helpers touch `localStorage` (guarded, same pattern
 * as lighting-scenes.ts).
 */

import {
  parseSceneConfig,
  sceneConfigToJson,
  sceneSummary,
  type LightingSceneConfig,
} from './lighting-scenes.ts';
import { CUSTOM_LIGHT_SLOTS, buildPresetColors, rgbToHex } from './proto/light.ts';
import { decodeKeyValue } from './proto/khub916.ts';
import { poolNameFor } from './keypool.ts';
import { canApplyProfile, type ApplyCheck } from './core/compatibility.ts';
import { detectDevice, type DeviceLike, type ProtocolKind } from './core/device-model.ts';
import type { FeatureId } from './core/feature-registry.ts';

// ── Types ──────────────────────────────────────────────────────────────

export type PresetKind = 'lighting' | 'keymap';

/** What a preset applies to — checked against a device before offering. */
export interface PresetTarget {
  /** Protocol family (`khub916`, `he-v2`, ...). Omit = any. */
  protocol?: ProtocolKind;
  /** Vendor catalog model ids / names the preset was designed for. */
  models?: readonly string[];
  /** UI feature ids the preset requires (feature-registry.ts). */
  features?: readonly FeatureId[];
}

/**
 * Layer-0 keymap snippet: slot index (0–127, `pos = 8 + n*4` on the
 * K1 Pro layout) → raw u32 keymap value (spec §6 encoding).
 */
export interface KeymapSnippetConfig {
  /** User layer 0–3 (keymap arg low bits). */
  layer: number;
  /** System key-set variant (arg bit 2). */
  system: boolean;
  slots: Record<number, number>;
}

export type PresetConfig = LightingSceneConfig | KeymapSnippetConfig;

/** A preset minus storage bookkeeping — what files carry. */
export interface PresetDraft {
  name: string;
  kind: PresetKind;
  description: string;
  experimental?: boolean;
  target: PresetTarget;
  config: PresetConfig;
}

export interface Preset extends PresetDraft {
  /** Stable id — `builtin-*` for the catalog, `user-*` for saved presets. */
  id: string;
  builtin: boolean;
  savedAt?: number;
}

// ── Config validation ──────────────────────────────────────────────────

function isObj(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

const KEYMAP_SLOTS = 128;

/**
 * Validate + normalise a keymap snippet. Accepts a parsed object;
 * returns a fresh config. Throws `Error` with a readable message.
 * Slot indices must be 0–127 and values must be u32 keymap values —
 * every value is decoded with `decodeKeyValue` so a malformed tag is
 * rejected up front rather than written blind.
 */
export function validateKeymapSnippet(input: unknown): KeymapSnippetConfig {
  if (!isObj(input)) throw new Error('Keymap preset must be a JSON object.');
  const layer = input.layer ?? 0;
  if (typeof layer !== 'number' || !Number.isInteger(layer) || layer < 0 || layer > 3) {
    throw new Error(`keymap preset layer must be an integer 0–3, got ${JSON.stringify(input.layer)}`);
  }
  const system = input.system ?? false;
  if (typeof system !== 'boolean') {
    throw new Error('keymap preset "system" must be a boolean.');
  }
  if (!isObj(input.slots)) throw new Error('keymap preset needs a "slots" object.');
  const slots: Record<number, number> = {};
  for (const [k, v] of Object.entries(input.slots)) {
    const index = Number(k);
    if (!Number.isInteger(index) || index < 0 || index >= KEYMAP_SLOTS || String(index) !== k.trim()) {
      throw new Error(`keymap preset slot index must be 0–127, got "${k}".`);
    }
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 0xffffffff) {
      throw new Error(`keymap preset slot ${index}: value must be an integer 0–0xffffffff, got ${JSON.stringify(v)}.`);
    }
    const kv = decodeKeyValue(v >>> 0);
    if (kv.kind === 'unknown') {
      throw new Error(
        `keymap preset slot ${index}: value 0x${(v >>> 0).toString(16)} uses an unrecognised tag — refusing to guess.`,
      );
    }
    slots[index] = v >>> 0;
  }
  if (Object.keys(slots).length === 0) {
    throw new Error('keymap preset has no bindings.');
  }
  return { layer, system, slots };
}

/** Validate `config` for `kind`; returns the normalised config. */
export function validatePresetConfig(kind: PresetKind, config: unknown): PresetConfig {
  if (kind === 'lighting') return parseSceneConfig(config);
  return validateKeymapSnippet(config);
}

/** Human label for a keymap slot value (pool name or decoded label). */
export function keymapValueLabel(value: number): string {
  const pool = poolNameFor(value);
  if (pool) return pool;
  const kv = decodeKeyValue(value);
  if (kv.kind === 'empty') return '(none)';
  // Cheap label without pulling the full label table into summaries:
  // modifier chord / fn / macro tags are self-describing.
  switch (kv.kind) {
    case 'normal': {
      const mods = [
        kv.ctrl ? 'Ctrl' : '',
        kv.shift ? 'Shift' : '',
        kv.alt ? 'Alt' : '',
        kv.gui ? 'Win' : '',
      ].filter(Boolean);
      const usage = kv.usage === 0 ? '' : `0x${kv.usage.toString(16).padStart(4, '0')}`;
      return [...mods, usage].filter(Boolean).join('+') || '(bare modifier)';
    }
    case 'fn':
      return kv.layer === 0 ? 'Fn' : `Fn layer ${kv.layer}`;
    case 'macro':
      return `macro(${kv.macroType},${kv.number},${kv.index})`;
    default:
      return `0x${value.toString(16)}`;
  }
}

/** One-line summary for lists, e.g. `Breathing · speed 8 · brightness 12`. */
export function presetSummary(p: Preset): string {
  if (p.kind === 'lighting') return sceneSummary(p.config as LightingSceneConfig);
  const c = p.config as KeymapSnippetConfig;
  const n = Object.keys(c.slots).length;
  return `Key set ${c.layer + 1}${c.system ? ' (system)' : ''} · ${n} binding${n === 1 ? '' : 's'}`;
}

// ── Compatibility ──────────────────────────────────────────────────────

/**
 * Check a preset against a device (`DeviceLike` — HIDDevice-ish or a
 * khub916 `DeviceInfo`). Read-only; reuses `canApplyProfile`. When the
 * preset lists several models the check passes if ANY model matches.
 */
export function presetCompatibility(p: Preset, device: DeviceLike): ApplyCheck {
  const detected = detectDevice(device);
  const target = p.target;
  const models = target.models && target.models.length > 0 ? target.models : [undefined];

  // Cheap protocol pre-check so a khub916-only preset doesn't produce
  // four near-identical model-mismatch reasons on an HE keyboard.
  if (target.protocol && detected.protocol !== target.protocol) {
    return {
      ok: false,
      reasons: [
        `preset "${p.name}" targets protocol "${target.protocol}" but this device speaks "${detected.protocol}"`,
      ],
    };
  }

  let best: ApplyCheck | null = null;
  for (const model of models) {
    const r = canApplyProfile(device, {
      protocol: target.protocol,
      model,
      features: target.features,
    });
    if (r.ok) return { ok: true, reasons: [] };
    if (!best || r.reasons.length < best.reasons.length) best = r;
  }
  return best ?? { ok: true, reasons: [] };
}

// ── Built-in catalog ───────────────────────────────────────────────────

function lightingConfig(partial: Omit<LightingSceneConfig, 'schema'>): LightingSceneConfig {
  return { schema: 1, ...partial };
}

/** WASD highlight: 126-slot custom table, WASD bright, rest dim. */
function wasdHighlightConfig(): LightingSceneConfig {
  // Keymap slot indices on the K1 Pro layout (`pos = 8 + n*4`):
  // A=9, W=14, S=15, D=21 (see k1pro-layout.ts).
  const wasd = new Set([9, 14, 15, 21]);
  const colors = Array.from({ length: CUSTOM_LIGHT_SLOTS }, (_, i) =>
    rgbToHex(wasd.has(i) ? { r: 0x35, g: 0xf0, b: 0xff } : { r: 0x0d, g: 0x11, b: 0x17 }),
  );
  return lightingConfig({ mode: 277, speed: 0, brightness: 0, keys: { colors } });
}

/** Caps Lock indicator: static per-key highlight on the Caps key (index 3). */
function capsIndicatorConfig(): LightingSceneConfig {
  const colors = buildPresetColors({ preset: 'solid', color: '#0a0a0a' }).map(rgbToHex);
  colors[3] = '#ffd24a'; // Caps Lock key slot
  return lightingConfig({ mode: 277, speed: 0, brightness: 0, keys: { colors } });
}

const KH916_LIGHTING: PresetTarget = {
  protocol: 'khub916',
  features: ['lighting-studio'],
};

const KH916_PER_KEY: PresetTarget = {
  protocol: 'khub916',
  features: ['per-key-rgb'],
};

const K1PRO_KEYMAP: PresetTarget = {
  protocol: 'khub916',
  models: ['916_K1_PRO'],
  features: ['keymap-editor'],
};

/**
 * Built-in presets. Lighting configs are valid `light apply` shapes —
 * `smoke-presets.ts` round-trips every one through `parseSceneConfig`.
 * Keymap presets are layer-0 snippets marked experimental.
 */
export const BUILTIN_PRESETS: readonly Preset[] = [
  {
    id: 'builtin-light-off',
    builtin: true,
    kind: 'lighting',
    name: 'Lights Off',
    description: 'Switch all lighting off (mode 0).',
    target: KH916_LIGHTING,
    config: lightingConfig({ mode: 0, speed: 0, brightness: 0 }),
  },
  {
    id: 'builtin-light-gaming-red',
    builtin: true,
    kind: 'lighting',
    name: 'Gaming Red',
    description: 'Breathing red — faster and brighter than stock defaults.',
    target: KH916_LIGHTING,
    config: lightingConfig({
      mode: 2, // breathing
      speed: 9,
      brightness: 15,
      color_model: 2,
      color: '#ff2a2a',
    }),
  },
  {
    id: 'builtin-light-cyberpunk',
    builtin: true,
    kind: 'lighting',
    name: 'Cyberpunk',
    description: 'Multi-colour windmill sweep — firmware generates the palette.',
    target: KH916_LIGHTING,
    config: lightingConfig({ mode: 15, speed: 12, brightness: 13 }),
  },
  {
    id: 'builtin-light-minimal-white',
    builtin: true,
    kind: 'lighting',
    name: 'Minimal White',
    description: 'Steady low-brightness white — easy on the eyes.',
    target: KH916_LIGHTING,
    config: lightingConfig({
      mode: 1, // always_on
      speed: 0,
      brightness: 9,
      color_model: 2,
      color: '#f2f2f2',
    }),
  },
  {
    id: 'builtin-light-productivity',
    builtin: true,
    kind: 'lighting',
    name: 'Productivity',
    description: 'Slow cool-blue flow — visible but not distracting.',
    target: KH916_LIGHTING,
    config: lightingConfig({
      mode: 10, // flowing
      speed: 6,
      brightness: 10,
      color_model: 2,
      color: '#3d9bff',
    }),
  },
  {
    id: 'builtin-light-wasd-highlight',
    builtin: true,
    kind: 'lighting',
    name: 'WASD Highlight',
    description: 'Custom per-key mode: WASD glow cyan, everything else near-off.',
    target: KH916_PER_KEY,
    config: wasdHighlightConfig(),
  },
  {
    id: 'builtin-light-caps-indicator',
    builtin: true,
    kind: 'lighting',
    name: 'Caps Lock Indicator',
    description:
      'Custom per-key mode: the Caps key glows amber, the rest stay dark. ' +
      'Static — khub916 has no conditional (caps-state) lighting.',
    target: KH916_PER_KEY,
    config: capsIndicatorConfig(),
  },
  {
    id: 'builtin-km-nav-home-end',
    builtin: true,
    kind: 'keymap',
    name: 'Nav: Home & End',
    description:
      'Experimental layer-0 snippet: PgUp sends Home, PgDn sends End ' +
      '(K1 Pro slot indices 92/93). Review before applying.',
    experimental: true,
    target: K1PRO_KEYMAP,
    config: {
      layer: 0,
      system: false,
      // K1 Pro nav cluster: PgUp (pos 376 → index 92), PgDn (pos 380 → 93).
      // HID usages: Home 0x4A = 74, End 0x4D = 77.
      slots: { 92: 74, 93: 77 },
    },
  },
  {
    id: 'builtin-km-caps-ctrl',
    builtin: true,
    kind: 'keymap',
    name: 'Caps → Left Ctrl',
    description:
      'Experimental layer-0 snippet: Caps Lock becomes Left Ctrl ' +
      '(K1 Pro slot index 3, modifier-only value 0x00010000).',
    experimental: true,
    target: K1PRO_KEYMAP,
    config: {
      layer: 0,
      system: false,
      slots: { 3: 0x00010000 },
    },
  },
];

// ── User preset store (localStorage) ───────────────────────────────────

export const PRESET_STORAGE_KEY = 'omg.presets.v1';
const NAME_MAX = 64;
const FILE_MARKER = 'omg_preset';

interface StoredPreset extends PresetDraft {
  id: string;
  savedAt: number;
}

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function validPresetName(name: string): string | null {
  const n = name.trim();
  if (n.length === 0) return 'Give the preset a name.';
  if (n.length > NAME_MAX) return `Preset names are at most ${NAME_MAX} characters.`;
  return null;
}

function readAll(): StoredPreset[] {
  const s = storage();
  if (!s) return [];
  try {
    const raw = JSON.parse(s.getItem(PRESET_STORAGE_KEY) ?? '[]') as unknown;
    if (!Array.isArray(raw)) return [];
    const out: StoredPreset[] = [];
    for (const item of raw) {
      if (!isObj(item) || typeof item.id !== 'string' || typeof item.name !== 'string') continue;
      if (item.kind !== 'lighting' && item.kind !== 'keymap') continue;
      try {
        out.push({
          id: item.id,
          name: item.name,
          kind: item.kind,
          description: typeof item.description === 'string' ? item.description : '',
          experimental: item.experimental === true,
          target: isObj(item.target) ? (item.target as PresetTarget) : {},
          config: validatePresetConfig(item.kind, item.config),
          savedAt: typeof item.savedAt === 'number' ? item.savedAt : 0,
        });
      } catch {
        // Skip corrupt entries rather than losing the whole list.
      }
    }
    return out;
  } catch {
    return [];
  }
}

function writeAll(presets: StoredPreset[]): void {
  const s = storage();
  if (!s) return;
  try {
    s.setItem(PRESET_STORAGE_KEY, JSON.stringify(presets));
  } catch {
    // Quota/serialisation failure — the in-memory list still works.
  }
}

function toPreset(stored: StoredPreset): Preset {
  return { ...stored, builtin: false };
}

/** All presets — built-ins first (catalog order), then user presets by name. */
export function listPresets(kind?: PresetKind): Preset[] {
  const builtins = BUILTIN_PRESETS.filter((p) => !kind || p.kind === kind);
  const users = readAll()
    .map(toPreset)
    .filter((p) => !kind || p.kind === kind)
    .sort((a, b) => a.name.localeCompare(b.name));
  return [...builtins, ...users];
}

export function getPreset(id: string): Preset | null {
  const builtin = BUILTIN_PRESETS.find((p) => p.id === id);
  if (builtin) return builtin;
  const stored = readAll().find((p) => p.id === id);
  return stored ? toPreset(stored) : null;
}

function slugify(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  return slug || 'preset';
}

/**
 * Validate + store a user preset. `id` is generated (`user-<slug>-<rand>`);
 * pass `opts.id` only from import flows that already validated a draft.
 * Returns the stored preset.
 */
export function savePreset(
  draft: PresetDraft,
  opts: { id?: string } = {},
): Preset {
  if (draft.kind !== 'lighting' && draft.kind !== 'keymap') {
    throw new Error(`Unknown preset kind ${JSON.stringify(draft.kind)}.`);
  }
  const problem = validPresetName(draft.name);
  if (problem) throw new Error(problem);
  const config = validatePresetConfig(draft.kind, draft.config);
  const all = readAll();
  let id = opts.id ?? '';
  if (!id || all.some((p) => p.id === id) || BUILTIN_PRESETS.some((p) => p.id === id)) {
    id = `user-${slugify(draft.name)}-${Date.now().toString(36)}${Math.floor(
      Math.random() * 1296,
    ).toString(36)}`;
  }
  const rec: StoredPreset = {
    id,
    name: draft.name.trim(),
    kind: draft.kind,
    description: draft.description ?? '',
    experimental: draft.experimental === true,
    target: draft.target ?? {},
    config,
    savedAt: Date.now(),
  };
  // Replace on id collision (re-import / re-save), else append.
  const next = all.filter((p) => p.id !== id);
  next.push(rec);
  writeAll(next);
  return toPreset(rec);
}

/** Rename a user preset. Built-ins are immutable — throws. */
export function renamePreset(id: string, name: string): Preset {
  const problem = validPresetName(name);
  if (problem) throw new Error(problem);
  const all = readAll();
  const idx = all.findIndex((p) => p.id === id);
  if (idx < 0) throw new Error(`No user preset "${id}".`);
  all[idx] = { ...all[idx]!, name: name.trim(), savedAt: Date.now() };
  writeAll(all);
  return toPreset(all[idx]!);
}

/** Delete a user preset. Returns false for built-ins / unknown ids. */
export function deletePreset(id: string): boolean {
  if (BUILTIN_PRESETS.some((p) => p.id === id)) return false;
  const all = readAll();
  const next = all.filter((p) => p.id !== id);
  if (next.length === all.length) return false;
  writeAll(next);
  return true;
}

// ── Preset files (.json export/import) ─────────────────────────────────

/** Serialise a preset for download — wrapped so imports stay self-describing. */
export function presetFileText(p: Preset): string {
  const body: Record<string, unknown> = {
    name: p.name,
    kind: p.kind,
    description: p.description,
  };
  if (p.experimental) body.experimental = true;
  if (p.target && Object.keys(p.target).length > 0) body.target = p.target;
  body.config =
    p.kind === 'lighting'
      ? JSON.parse(sceneConfigToJson(p.config as LightingSceneConfig))
      : p.config;
  return JSON.stringify({ [FILE_MARKER]: 1, preset: body }, null, 2);
}

/**
 * Parse a preset file. Accepts the wrapped export format only (a bare
 * scene config is NOT a preset — it has no name/kind). Returns a draft
 * ready for `savePreset`; the id is regenerated on save.
 */
export function parsePresetFile(text: string): PresetDraft {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`Preset file is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!isObj(raw) || raw[FILE_MARKER] !== 1 || !isObj(raw.preset)) {
    throw new Error('Not an omg preset file (missing omg_preset marker).');
  }
  const p = raw.preset;
  const kind = p.kind;
  if (kind !== 'lighting' && kind !== 'keymap') {
    throw new Error(`Preset has unknown kind ${JSON.stringify(kind)}.`);
  }
  const name = typeof p.name === 'string' ? p.name : '';
  const problem = validPresetName(name);
  if (problem) throw new Error(problem);
  const target: PresetTarget = isObj(p.target) ? (p.target as PresetTarget) : {};
  return {
    name: name.trim(),
    kind,
    description: typeof p.description === 'string' ? p.description : '',
    experimental: p.experimental === true,
    target,
    config: validatePresetConfig(kind, p.config),
  };
}

/** `omg-preset-<slug>.json` download name. */
export function presetFileName(p: Preset): string {
  return `omg-preset-${p.kind}-${slugify(p.name)}.json`;
}
