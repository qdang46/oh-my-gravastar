/**
 * Layout model — the physical / visual / mapping separation
 * (docs/vision-full-custom.md §I, bead oh-my-gravastar-aur).
 *
 *   PHYSICAL layout  — real hardware geometry (key positions/sizes) for a
 *                      device model. Read-only metadata, ported from the
 *                      vendor keycode JSONs into layout-tables.ts. Never
 *                      editable, never sent to the device.
 *   VISUAL layout    — what the on-screen keyboard looks like: per-key
 *                      x/y/w/h/rotation overrides, custom legends and
 *                      hidden keys. Stored in localStorage ONLY; the
 *                      layout editor writes nothing to the keyboard.
 *   KEY MAPPING      — firmware function per key. Owned by
 *                      remap.ts/keymap — this module never touches it;
 *                      `pos`/`keyIndex` only *reference* keymap slots.
 *
 * DOM-free and `node --experimental-strip-types` safe (types only, no
 * enums or runtime TS syntax) so scripts/test-layout.ts can exercise it
 * under plain Node.
 */

import { LAYOUT_TABLES, MODEL_LAYOUT, type RawKeyRow } from './layout-tables.ts';
import type { KeyValueStorage } from './safety/snapshots.ts';

// ── Physical layout ────────────────────────────────────────────────────

export interface PhysicalKey {
  /** Stable id used by visual overrides: `k<keyIndex>` (keymap slot n). */
  id: string;
  /** Factory legend from the vendor table ("" = unnamed slot). */
  name: string;
  /** Keymap-domain position (`pos = 8 + n*4`). */
  pos: number;
  /** Keymap/light table index n (`pos = 8 + n*4`), 0..127. */
  keyIndex: number;
  /** Factory default key value hex (`"0x…"`) — label fallback only. */
  value: string;
  /** Geometry in vendor key units (1u = 44 px). */
  x: number;
  y: number;
  width: number;
  height: number;
  /** false = keymap slot with no physical keycap (media/aux positions). */
  display: boolean;
}

export interface PhysicalLayout {
  /** Table id — also the `layout` field of visual-layout JSON. */
  id: string;
  /** Display name for the picker. */
  name: string;
  /** catalogModel values that use this exact table (may be several). */
  models: readonly string[];
  /** Provenance note (vendor file the table was ported from). */
  source: string;
  /** Size of one key unit in px (vendor uses 44). */
  unitPx: number;
  keys: readonly PhysicalKey[];
}

const MODEL_TO_FILE: Readonly<Record<string, string>> = {
  '916_K1': 'keyboard_916_K1.json',
  '916_K1_PRO': 'keyboard_916_K1_PRO.json',
  '916_K1_LITE': 'keyboard_916_K1_LITE.json',
  '916_K98Pro': 'keyboard_916_K98Pro.json',
  '916_GravaStar_Mercury_NP': 'keyboard_916_GravaStar_Mercury_NP.json',
  '916_K1_JP': 'keyboard_916_K1_JP.json',
  '916_K1_LITE_JP': 'keyboard_916_K1_LITE_JP.json',
  '916_K1_LITE_PRO_JP': 'keyboard_916_K1_LITE_PRO_JP.json',
  '916_K1_PRO_DE': 'keyboard_916_K1_PRO_DE.json',
  '916_K1_DE': 'keyboard_916_K1_DE.json',
  '916_K1_LITE_DE': 'keyboard_916_K1_LITE_DE.json',
  '916_K98Pro_JP': 'keyboard_916_K98Pro_JP.json',
  '916_K98Pro_DE': 'keyboard_916_K98Pro_DE.json',
  '916_K98Pro_SE': 'keyboard_916_K98Pro_SE.json',
};

function buildPhysical(id: string): PhysicalLayout {
  const rows = LAYOUT_TABLES[id];
  if (!rows) throw new Error(`layout-model: unknown physical layout '${id}'`);
  const keys: PhysicalKey[] = rows.map((r: RawKeyRow) => {
    const [name, x, y, width, height, display, pos, value] = r;
    const keyIndex = (pos - 8) / 4;
    return {
      id: `k${keyIndex}`,
      name,
      pos,
      keyIndex,
      value,
      x,
      y,
      width,
      height,
      display: display === 1,
    };
  });
  const models = Object.keys(MODEL_LAYOUT).filter((m) => MODEL_LAYOUT[m] === id);
  return {
    id,
    name: id,
    models,
    source: `vendor keycodeConfig/${MODEL_TO_FILE[id] ?? `keyboard_${id}.json`} (docs/research/khub-webapp)`,
    unitPx: 44,
    keys,
  };
}

/** All registered physical layouts (one per unique vendor table). */
export const PHYSICAL_LAYOUTS: readonly PhysicalLayout[] = Object.keys(LAYOUT_TABLES).map(
  buildPhysical,
);

const BY_ID = new Map(PHYSICAL_LAYOUTS.map((l) => [l.id, l]));

export function physicalLayoutById(id: string): PhysicalLayout | undefined {
  return BY_ID.get(id);
}

/**
 * Physical layout for a catalogModel. Returns undefined for models with
 * no ported table (the editor then offers the full picker — physical
 * selection is display metadata only).
 */
export function physicalLayoutForModel(model: string | null | undefined): PhysicalLayout | undefined {
  if (!model) return undefined;
  const id = MODEL_LAYOUT[model];
  return id ? BY_ID.get(id) : undefined;
}

/** Pixel bounds of the *displayed* physical keys (vendor `g()` approach). */
export function physicalBounds(layout: PhysicalLayout): { width: number; height: number } {
  const shown = layout.keys.filter((k) => k.display);
  if (shown.length === 0) return { width: 0, height: 0 };
  const maxX = Math.max(...shown.map((k) => k.x));
  const maxY = Math.max(...shown.map((k) => k.y));
  return { width: maxX + layout.unitPx, height: maxY + layout.unitPx };
}

// ── Visual layout (localStorage-only overrides) ────────────────────────

export const VISUAL_SCHEMA = 1;

/** Per-key visual override; absent fields keep the physical value. */
export interface VisualKeyOverride {
  x?: number;
  y?: number;
  /** Visual width/height in key units (px ÷ unitPx is *not* required —
   *  values are stored in the same px units as the physical table). */
  w?: number;
  h?: number;
  /** Rotation in degrees, normalized to [0,360). */
  rotation?: number;
  /** Custom legend; empty string restores the factory name. */
  legend?: string;
  /** Hide the keycap on the visual layout (slot stays in the keymap). */
  hidden?: boolean;
}

export interface VisualLayoutDoc {
  schema: typeof VISUAL_SCHEMA;
  /** Physical layout this visual layout applies to. */
  layout: string;
  /** catalogModel the layout was saved for (metadata, may be null). */
  model: string | null;
  /** Overrides keyed by PhysicalKey.id (`k<n>`). */
  keys: Record<string, VisualKeyOverride>;
}

/** A physical key after visual overrides are applied. */
export interface ResolvedKey extends PhysicalKey {
  /** Effective geometry (physical + overrides). */
  vx: number;
  vy: number;
  vw: number;
  vh: number;
  rotation: number;
  /** Effective legend: custom legend, else factory name. */
  legend: string;
  /** Hidden keys are skipped by the renderer but keep their slot. */
  hidden: boolean;
}

export function emptyVisualDoc(layoutId: string, model: string | null): VisualLayoutDoc {
  return { schema: VISUAL_SCHEMA, layout: layoutId, model, keys: {} };
}

function normRotation(r: number): number {
  const m = ((r % 360) + 360) % 360;
  return m === 0 ? 0 : m;
}

/** Apply a visual doc to a physical layout → effective render keys. */
export function resolveVisual(
  physical: PhysicalLayout,
  visual: VisualLayoutDoc | null | undefined,
): ResolvedKey[] {
  const overrides = visual?.keys ?? {};
  return physical.keys.map((k) => {
    const o = overrides[k.id];
    const legend = o?.legend !== undefined ? o.legend : k.name;
    return {
      ...k,
      vx: o?.x ?? k.x,
      vy: o?.y ?? k.y,
      vw: o?.w ?? k.width,
      vh: o?.h ?? k.height,
      rotation: normRotation(o?.rotation ?? 0),
      legend: legend === '' ? '' : legend.replace(/_/g, ' '),
      hidden: o?.hidden ?? false,
    };
  });
}

/** Bounds of the visible resolved keys (for canvas sizing). */
export function visualBounds(resolved: readonly ResolvedKey[]): { width: number; height: number } {
  const shown = resolved.filter((k) => k.display && !k.hidden);
  if (shown.length === 0) return { width: 0, height: 0 };
  const maxX = Math.max(...shown.map((k) => k.vx + k.vw));
  const maxY = Math.max(...shown.map((k) => k.vy + k.vh));
  const minX = Math.min(...shown.map((k) => k.vx));
  const minY = Math.min(...shown.map((k) => k.vy));
  return { width: maxX - Math.min(0, minX), height: maxY - Math.min(0, minY) };
}

export interface OverlapPair {
  a: string;
  b: string;
  /** Overlap area in px² (key-unit² actually — units are layout px). */
  area: number;
}

/**
 * Axis-aligned overlap pairs among visible resolved keys (warning only).
 * Touching edges (≤1 px overlap on either axis) are ignored — the vendor
 * tables pack keys with 1 px gaps, so adjacent keycaps legitimately
 * report a 1 px×height sliver.
 */
export function findOverlaps(resolved: readonly ResolvedKey[]): OverlapPair[] {
  const shown = resolved.filter((k) => k.display && !k.hidden && k.vw > 0 && k.vh > 0);
  const out: OverlapPair[] = [];
  for (let i = 0; i < shown.length; i++) {
    for (let j = i + 1; j < shown.length; j++) {
      const a = shown[i] as ResolvedKey;
      const b = shown[j] as ResolvedKey;
      const ox = Math.min(a.vx + a.vw, b.vx + b.vw) - Math.max(a.vx, b.vx);
      const oy = Math.min(a.vy + a.vh, b.vy + b.vh) - Math.max(a.vy, b.vy);
      if (ox > 1 && oy > 1) {
        out.push({ a: a.id, b: b.id, area: Math.round(ox * oy) });
      }
    }
  }
  return out;
}

// ── Validation ─────────────────────────────────────────────────────────

export interface LayoutValidation {
  ok: boolean;
  /** Fatal problems — the document must not be applied. */
  errors: string[];
  /** Non-fatal problems — shown to the user but the doc may apply. */
  warnings: string[];
  /** The validated doc when `ok` (normalized). */
  doc?: VisualLayoutDoc;
}

const MAX_COORD = 65536;
const MAX_SIZE = 8192;
const MAX_LEGEND = 128;
const MAX_KEYS = 256;

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * Validate a visual-layout JSON document (schema 1). `physical` is the
 * layout the doc will be applied to — pass it to get unknown-key and
 * bounds/overlap checks; omit for a schema-only check.
 * Accepts a JSON string or a parsed value. Never throws.
 */
export function validateVisualLayout(
  input: unknown,
  physical?: PhysicalLayout,
): LayoutValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  let doc = input;
  if (typeof doc === 'string') {
    try {
      doc = JSON.parse(doc);
    } catch (e) {
      return {
        ok: false,
        errors: [`layout file: invalid JSON: ${e instanceof Error ? e.message : String(e)}`],
        warnings,
      };
    }
  }
  if (!isObj(doc)) {
    return { ok: false, errors: ['layout file: top level must be a JSON object'], warnings };
  }
  if (doc.schema !== VISUAL_SCHEMA) {
    errors.push(`layout file: unsupported schema ${JSON.stringify(doc.schema)} (want ${VISUAL_SCHEMA})`);
  }
  const layoutId = doc.layout;
  let target = physical;
  if (layoutId !== undefined) {
    if (typeof layoutId !== 'string' || !BY_ID.has(layoutId)) {
      errors.push(`layout file: unknown physical layout ${JSON.stringify(layoutId)}`);
    } else {
      target = BY_ID.get(layoutId);
      if (physical && layoutId !== physical.id) {
        warnings.push(
          `layout file targets '${layoutId}', not the selected '${physical.id}' — it will be stored under '${layoutId}'`,
        );
      }
    }
  } else if (!physical) {
    errors.push("layout file: missing 'layout' (physical layout id)");
  }
  const model = doc.model;
  if (model !== undefined && model !== null && typeof model !== 'string') {
    errors.push('layout file: model must be a string or null');
  }
  const keysRaw = doc.keys;
  if (keysRaw !== undefined && !isObj(keysRaw)) {
    errors.push("layout file: 'keys' must be an object keyed by key id");
  }
  const out: Record<string, VisualKeyOverride> = {};
  if (isObj(keysRaw)) {
    const ids = Object.keys(keysRaw);
    if (ids.length > MAX_KEYS) {
      errors.push(`layout file: ${ids.length} key overrides — cap is ${MAX_KEYS}`);
    }
    const known = target ? new Set(target.keys.map((k) => k.id)) : null;
    for (const id of ids) {
      const o = keysRaw[id];
      const ctx = `keys.${id}`;
      if (!isObj(o)) {
        errors.push(`${ctx}: override must be an object`);
        continue;
      }
      if (known && !known.has(id)) {
        errors.push(`${ctx}: unknown key for layout '${target?.id}'`);
        continue;
      }
      const clean: VisualKeyOverride = {};
      let bad = false;
      for (const f of ['x', 'y', 'w', 'h', 'rotation'] as const) {
        if (o[f] === undefined) continue;
        const v = num(o[f]);
        if (v === null) {
          errors.push(`${ctx}.${f}: must be a finite number`);
          bad = true;
          continue;
        }
        if (f === 'w' || f === 'h') {
          if (v <= 0 || v > MAX_SIZE) {
            errors.push(`${ctx}.${f}: size must be 0 < v <= ${MAX_SIZE}, got ${v}`);
            bad = true;
            continue;
          }
        } else if (Math.abs(v) > MAX_COORD) {
          errors.push(`${ctx}.${f}: |value| must be <= ${MAX_COORD}, got ${v}`);
          bad = true;
          continue;
        }
        clean[f] = f === 'rotation' ? normRotation(v) : v;
      }
      if (o.legend !== undefined) {
        if (typeof o.legend !== 'string') {
          errors.push(`${ctx}.legend: must be a string`);
          bad = true;
        } else if (o.legend.length > MAX_LEGEND) {
          errors.push(`${ctx}.legend: exceeds ${MAX_LEGEND} chars`);
          bad = true;
        } else {
          clean.legend = o.legend;
        }
      }
      if (o.hidden !== undefined) {
        if (typeof o.hidden !== 'boolean') {
          errors.push(`${ctx}.hidden: must be a boolean`);
          bad = true;
        } else {
          clean.hidden = o.hidden;
        }
      }
      const extra = Object.keys(o).filter(
        (k) => !['x', 'y', 'w', 'h', 'rotation', 'legend', 'hidden'].includes(k),
      );
      for (const k of extra) {
        warnings.push(`${ctx}.${k}: unknown field ignored`);
      }
      if (!bad) out[id] = clean; // empty override {} is harmless
    }
  }
  // Bounds + overlap warnings against the resolved layout.
  if (target && errors.length === 0) {
    const resolved = resolveVisual(target, {
      schema: VISUAL_SCHEMA,
      layout: target.id,
      model: typeof model === 'string' ? model : null,
      keys: out,
    });
    const b = physicalBounds(target);
    const margin = target.unitPx * 2;
    for (const k of resolved) {
      if (!k.display || k.hidden) continue;
      if (k.vx < -margin || k.vy < -margin || k.vx + k.vw > b.width + margin || k.vy + k.vh > b.height + margin) {
        warnings.push(`${k.id} (${k.legend || k.name || 'unnamed'}) sits outside the canvas bounds`);
      }
    }
    for (const p of findOverlaps(resolved)) {
      warnings.push(`keys ${p.a} and ${p.b} overlap (${p.area} px²)`);
    }
  }
  if (errors.length > 0) return { ok: false, errors, warnings };
  const layout = typeof layoutId === 'string' ? layoutId : (target?.id ?? '');
  return {
    ok: true,
    errors,
    warnings,
    doc: {
      schema: VISUAL_SCHEMA,
      layout,
      model: typeof model === 'string' ? model : null,
      keys: out,
    },
  };
}

// ── Persistence (localStorage via the safety KeyValueStorage contract) ─

export const LAYOUT_STORAGE_PREFIX = 'omg.layout.v1.';

export function layoutStorageKey(model: string | null, layoutId: string): string {
  return `${LAYOUT_STORAGE_PREFIX}${model ?? 'unknown'}.${layoutId}`;
}

function defaultStorage(): KeyValueStorage {
  try {
    if (typeof localStorage !== 'undefined') return localStorage;
  } catch {
    // access can throw in opaque origins
  }
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

/** Load the saved visual layout for (model, layoutId); null when absent/invalid. */
export function loadVisualLayout(
  model: string | null,
  layoutId: string,
  storage: KeyValueStorage = defaultStorage(),
): VisualLayoutDoc | null {
  const physical = BY_ID.get(layoutId);
  if (!physical) return null;
  const raw = storage.getItem(layoutStorageKey(model, layoutId));
  if (raw === null) return null;
  const v = validateVisualLayout(raw, physical);
  return v.ok && v.doc ? v.doc : null;
}

/** Persist a visual layout. Only writes to the injected storage — never HID. */
export function saveVisualLayout(
  doc: VisualLayoutDoc,
  storage: KeyValueStorage = defaultStorage(),
): void {
  storage.setItem(layoutStorageKey(doc.model, doc.layout), JSON.stringify(doc));
}

export function clearVisualLayout(
  model: string | null,
  layoutId: string,
  storage: KeyValueStorage = defaultStorage(),
): void {
  storage.removeItem(layoutStorageKey(model, layoutId));
}

/** Serialize a doc for export (pretty JSON). */
export function visualLayoutToJson(doc: VisualLayoutDoc): string {
  return JSON.stringify(doc, null, 2) + '\n';
}
