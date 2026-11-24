/**
 * khub916 lighting codec — TypeScript port of
 * `crates/proto-khub916/src/light.rs` and the config-resolution half of
 * `crates/omg/src/kb916_light.rs` (schema: `docs/lighting-schema.md`).
 *
 * DOM-free so `scripts/smoke.ts` can exercise it under plain Node.
 *
 * Vendor model (wired 916):
 * - effect mode lives in the profile blob at `raw[9..11]`; per-mode
 *   speed/brightness records sit past the first `FF FF` pair;
 * - cmd-138 light data = 21-byte groups, group `m` at `m*21`, bytes 0-2
 *   the mode's RGB (vendor `getGroupColor`);
 * - cmd-134/6 custom per-key colours = 126 slots in R/G/B planes.
 */

import { CUSTOM_LIGHT_ENTRIES, FEATURE_PAYLOAD_BYTES, HEADER_LEN } from './khub916.ts';

// ── Constants ──────────────────────────────────────────────────────────

export const LIGHT_GROUP_STRIDE = 21;
export const LIGHT_GROUP_COLOR_LEN = 3;
export const CUSTOM_LIGHT_SLOTS = CUSTOM_LIGHT_ENTRIES; // 126
export const LIGHT_SPECIAL_MODES: readonly number[] = [0, 19, 275, 277];

export const COLOR_SUPPORT = { OFF: 0, SINGLE: 1, CUSTOM: 2, MULTI: 3 } as const;
export const COLOR_MODEL = { MONOCHROME: 1, MIXING: 2 } as const;

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

// ── Mode table (vendor `i("916")` + `Ct` list; port of LIGHT_MODES) ────

export interface LightModeInfo {
  /** Wire mode id (profile `raw[9..11]`). */
  id: number;
  name: string;
  /** [`COLOR_SUPPORT`] code. */
  colorSupport: number;
  /** Vendor default `colorModel` (1 monochrome / 2 mixing). */
  defaultColorModel: number;
  /** Vendor `speedShowStatus` — false for custom (277) and always_on (1). */
  speedAdjustable: boolean;
}

const M = (
  id: number,
  name: string,
  colorSupport: number,
  defaultColorModel: number,
  speedAdjustable: boolean,
): LightModeInfo => ({ id, name, colorSupport, defaultColorModel, speedAdjustable });

/** The 916 wired effect table — 18 ids, same order as the vendor list. */
export const LIGHT_MODES: readonly LightModeInfo[] = [
  M(0, 'off', COLOR_SUPPORT.OFF, COLOR_MODEL.MIXING, true),
  M(277, 'custom', COLOR_SUPPORT.CUSTOM, COLOR_MODEL.MONOCHROME, false),
  M(1, 'always_on', COLOR_SUPPORT.SINGLE, COLOR_MODEL.MIXING, false),
  M(2, 'breathing', COLOR_SUPPORT.SINGLE, COLOR_MODEL.MIXING, true),
  M(3, 'dream_rainbow', COLOR_SUPPORT.MULTI, COLOR_MODEL.MIXING, true),
  M(4, 'one_touch', COLOR_SUPPORT.SINGLE, COLOR_MODEL.MIXING, true),
  M(5, 'rain_walk', COLOR_SUPPORT.SINGLE, COLOR_MODEL.MIXING, true),
  M(6, 'color_wheel', COLOR_SUPPORT.SINGLE, COLOR_MODEL.MIXING, true),
  M(7, 'key_ripple', COLOR_SUPPORT.SINGLE, COLOR_MODEL.MIXING, true),
  M(8, 'stars', COLOR_SUPPORT.SINGLE, COLOR_MODEL.MIXING, true),
  M(9, 'snow_trace', COLOR_SUPPORT.SINGLE, COLOR_MODEL.MIXING, true),
  M(10, 'flowing', COLOR_SUPPORT.SINGLE, COLOR_MODEL.MIXING, true),
  M(11, 'wave', COLOR_SUPPORT.SINGLE, COLOR_MODEL.MIXING, true),
  M(12, 'shadow', COLOR_SUPPORT.SINGLE, COLOR_MODEL.MIXING, true),
  M(13, 'sine_wave', COLOR_SUPPORT.SINGLE, COLOR_MODEL.MIXING, true),
  M(15, 'windmill', COLOR_SUPPORT.MULTI, COLOR_MODEL.MIXING, true),
  M(16, 'waterfall', COLOR_SUPPORT.MULTI, COLOR_MODEL.MIXING, true),
  M(17, 'blooming', COLOR_SUPPORT.MULTI, COLOR_MODEL.MIXING, true),
] as const;

/** Table row for a mode id; `undefined` for ids outside the vendor list. */
export function lightModeInfo(id: number): LightModeInfo | undefined {
  return LIGHT_MODES.find((m) => m.id === id);
}

// ── Profile light-state decode (vendor `getKeyboardLight`) ─────────────

export interface LightState {
  mode: number;
  speed: number;
  brightness: number;
  /** 1 = monochrome, 2 = colour mixing. */
  colorModel: number;
}

/** Index just past the first `FF FF` pair — vendor `findSecond255Index`. */
export function findSecond255Index(blob: Uint8Array): number | null {
  for (let i = 0; i + 1 < blob.length; i++) {
    if (blob[i] === 0xff && blob[i + 1] === 0xff) return i + 2;
  }
  return null;
}

/**
 * Decode the current light state from the raw profile blob — port of
 * `decode_light_state`: record index uses `raw[10]` (mode low byte),
 * speed forced to 0 for special modes and mode 1, brightness to 0 for
 * special modes, `colorModel` 1 unless the packed low nibble is 7.
 */
export function decodeLightState(profileRaw: Uint8Array): LightState | null {
  const e = profileRaw;
  if (e.length < 11) return null;
  const base = findSecond255Index(e);
  if (base === null) return null;
  const mode = e[9] !== 0 ? ((e[9] ?? 0) << 8) | (e[10] ?? 0) : (e[10] ?? 0);
  const idx = e[10] ?? 0;
  const brightAt = base + idx * 2 - 2;
  const packedAt = brightAt + 1;
  if (packedAt < 0 || packedAt >= e.length) return null;
  const packed = e[packedAt] ?? 0;
  const special = LIGHT_SPECIAL_MODES.includes(mode);
  return {
    mode,
    speed: special || mode === 1 ? 0 : packed >> 4,
    brightness: special || brightAt < 0 || brightAt >= e.length ? 0 : (e[brightAt] ?? 0),
    colorModel: special ? COLOR_MODEL.MONOCHROME : (packed & 0x0f) === 7 ? COLOR_MODEL.MIXING : COLOR_MODEL.MONOCHROME,
  };
}

// ── Profile write builder (port of `Profile::with_light_mode`) ─────────

/**
 * Return a copy of the profile blob with `mode` at `raw[9..11]` and, for
 * non-special modes, the per-mode brightness/speed record at
 * `base + mode*2 - 2` / `base + mode*2 - 1`. `lightType` 1 packs type
 * code 0 (monochrome), anything else 7 (mixing). Throws when the mode
 * does not fit the blob's record table — before anything is sent.
 */
export function withLightMode(
  profileRaw: Uint8Array,
  mode: number,
  speed: number,
  bright: number,
  lightType: number,
): Uint8Array {
  if (speed > 20 || bright > 20) {
    throw new Error('khub916 light mode: speed/brightness must be ≤ 20 (vendor limit)');
  }
  if (profileRaw.length < 11) {
    throw new Error(`khub916 profile too short for light mode: ${profileRaw.length} bytes`);
  }
  const v = profileRaw.slice();
  v[9] = (mode & 0xff00) >> 8;
  v[10] = mode & 0x00ff;
  const base = findSecond255Index(v);
  if (base === null) {
    throw new Error('khub916 profile: no FF FF marker (config table missing)');
  }
  if (!LIGHT_SPECIAL_MODES.includes(mode)) {
    const brightAt = base + mode * 2 - 2;
    const packedAt = brightAt + 1;
    if (brightAt < 0 || packedAt >= v.length) {
      throw new Error(
        `khub916 light mode ${mode} out of range for this profile (${v.length} bytes, table base ${base})`,
      );
    }
    v[brightAt] = bright & 0xff;
    v[packedAt] = (((speed & 15) << 4) | (lightType === 1 ? 0 : 7)) & 0xff;
  }
  return v;
}

// ── Cmd-138 light-data blob (port of decode_light_data) ────────────────

export interface LightGroup {
  /** Group index = mode id the group belongs to. */
  index: number;
  offset: number;
  color: Rgb;
  /** The full 21-byte group verbatim. */
  raw: Uint8Array;
}

export interface LightDataInfo {
  bytes: number;
  groups: LightGroup[];
  tailLen: number;
}

/** Decode a cmd-138 blob into per-mode groups (bytes 0-2 = RGB). */
export function decodeLightData(blob: Uint8Array): LightDataInfo {
  const groups: LightGroup[] = [];
  for (let i = 0; i + LIGHT_GROUP_STRIDE <= blob.length; i += LIGHT_GROUP_STRIDE) {
    const raw = blob.slice(i, i + LIGHT_GROUP_STRIDE);
    groups.push({
      index: groups.length,
      offset: i,
      color: { r: raw[0] ?? 0, g: raw[1] ?? 0, b: raw[2] ?? 0 },
      raw,
    });
  }
  return { bytes: blob.length, groups, tailLen: blob.length % LIGHT_GROUP_STRIDE };
}

/** Vendor `getGroupColor`: RGB at `mode * 21`; null when out of bounds. */
export function groupColor(blob: Uint8Array, mode: number): Rgb | null {
  const off = mode * LIGHT_GROUP_STRIDE;
  if (off + LIGHT_GROUP_COLOR_LEN > blob.length) return null;
  return { r: blob[off] ?? 0, g: blob[off + 1] ?? 0, b: blob[off + 2] ?? 0 };
}

/**
 * Vendor `updateGroupColor`: copy `blob` and overwrite the RGB triple at
 * `mode * 21`. Returns null when the group does not fit (the vendor
 * silently no-ops; callers treat null as "mode has no colour").
 */
export function withGroupColor(blob: Uint8Array, mode: number, color: Rgb): Uint8Array | null {
  const out = blob.slice();
  const off = mode * LIGHT_GROUP_STRIDE;
  if (off + LIGHT_GROUP_COLOR_LEN > out.length) return null;
  out[off] = color.r & 0xff;
  out[off + 1] = color.g & 0xff;
  out[off + 2] = color.b & 0xff;
  return out;
}

// ── Colour helpers (port of kb916_light.rs + proto-mouse Rgb) ──────────

/** `"#rrggbb"`, `"rrggbb"`, `"r,g,b"` or `{r,g,b}` → Rgb. Throws on bad input. */
export function parseColor(v: unknown, what = 'colour'): Rgb {
  if (typeof v === 'string') {
    const s = v.trim().replace(/^#/, '');
    if (s.includes(',')) {
      const parts = s.split(',').map((p) => p.trim());
      if (parts.length !== 3) throw new Error(`${what}: bad colour '${v}'`);
      const [r, g, b] = parts.map((p) => {
        const n = Number(p);
        if (!Number.isInteger(n) || n < 0 || n > 255) {
          throw new Error(`${what}: bad colour '${v}'`);
        }
        return n;
      });
      return { r: r as number, g: g as number, b: b as number };
    }
    if (s.length === 6 && /^[0-9a-fA-F]{6}$/.test(s)) {
      const n = parseInt(s, 16);
      return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff };
    }
    throw new Error(`${what}: bad colour '${v}' (want #rrggbb or r,g,b)`);
  }
  if (v !== null && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const get = (k: string): number => {
      const n = o[k];
      if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > 255) {
        throw new Error(`${what}: colour object needs integer '${k}' 0-255`);
      }
      return n;
    };
    return { r: get('r'), g: get('g'), b: get('b') };
  }
  throw new Error(`${what}: colour must be a string or {"r":…} object`);
}

export function rgbToHex(c: Rgb): string {
  return `#${[c.r, c.g, c.b].map((x) => (x & 0xff).toString(16).padStart(2, '0')).join('')}`;
}

/** HSV (h 0-360, s/v 0-1) → Rgb — port of `hsv()` in kb916_light.rs. */
export function hsvToRgb(hue: number, sat: number, val: number): Rgb {
  const h = (((hue % 360) + 360) % 360) / 60;
  const i = Math.floor(h);
  const f = h - i;
  const p = val * (1 - sat);
  const q = val * (1 - sat * f);
  const t = val * (1 - sat * (1 - f));
  const pick = (x: number): number => Math.round(Math.min(255, Math.max(0, x * 255)));
  switch (((i % 6) + 6) % 6) {
    case 0:
      return { r: pick(val), g: pick(t), b: pick(p) };
    case 1:
      return { r: pick(q), g: pick(val), b: pick(p) };
    case 2:
      return { r: pick(p), g: pick(val), b: pick(t) };
    case 3:
      return { r: pick(p), g: pick(q), b: pick(val) };
    case 4:
      return { r: pick(t), g: pick(p), b: pick(val) };
    default:
      return { r: pick(val), g: pick(p), b: pick(q) };
  }
}

/** Rgb → HSV for picker initialisation. */
export function rgbToHsv(c: Rgb): { h: number; s: number; v: number } {
  const r = c.r / 255;
  const g = c.g / 255;
  const b = c.b / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = 60 * (((g - b) / d) % 6);
    else if (max === g) h = 60 * ((b - r) / d + 2);
    else h = 60 * ((r - g) / d + 4);
  }
  if (h < 0) h += 360;
  return { h, s: max === 0 ? 0 : d / max, v: max };
}

function lerpRgb(a: Rgb, b: Rgb, t: number): Rgb {
  const ch = (x: number, y: number): number => Math.round(x + (y - x) * t);
  return { r: ch(a.r, b.r), g: ch(a.g, b.g), b: ch(a.b, b.b) };
}

// ── Custom-colour presets (port of build_custom_colors base cases) ──────

export type KeysPreset = 'solid' | 'gradient' | 'rainbow';

export interface KeysPresetSpec {
  preset: KeysPreset;
  color?: unknown;
  to?: unknown;
}

/**
 * Generate the 126-slot table for a preset — same semantics as the CLI:
 * solid fills `color` (default white), gradient lerps `color`→`to`
 * (defaults red→blue), rainbow sweeps hue `i*360/126`.
 */
export function buildPresetColors(spec: KeysPresetSpec): Rgb[] {
  const slots = CUSTOM_LIGHT_SLOTS;
  switch (spec.preset) {
    case 'solid': {
      const c = spec.color !== undefined ? parseColor(spec.color, 'keys.color') : { r: 255, g: 255, b: 255 };
      return Array.from({ length: slots }, () => ({ ...c }));
    }
    case 'gradient': {
      const from = spec.color !== undefined ? parseColor(spec.color, 'keys.color') : { r: 255, g: 0, b: 0 };
      const to = spec.to !== undefined ? parseColor(spec.to, 'keys.to') : { r: 0, g: 0, b: 255 };
      return Array.from({ length: slots }, (_, i) => lerpRgb(from, to, i / (slots - 1)));
    }
    case 'rainbow':
      return Array.from({ length: slots }, (_, i) => hsvToRgb((i * 360) / slots, 1, 1));
  }
}

/** True when two 126-slot tables are identical (skip-unchanged check). */
export function colorsEqual(a: readonly Rgb[], b: readonly Rgb[]): boolean {
  return a.length === b.length && a.every((c, i) => c.r === b[i]?.r && c.g === b[i]?.g && c.b === b[i]?.b);
}

// ── Wired cmd-10 light-data write packet ───────────────────────────────

/** Largest blob the fixed-marker packet can carry (payload bytes 7..=512). */
export const LIGHT_DATA_MAX = 506;

/**
 * Build the cmd-10 feature report for `write_light_data` — port of the
 * Rust packet layout: header `[10,0,0,0,0,0,2]` (byte 3 stays 0x00, NOT
 * the usual 0x01), blob at offset 7, zero-pad to 519, `5A A5` pinned at
 * packet bytes 513/514.
 */
export function buildLightDataPacket(data: Uint8Array): Uint8Array {
  if (data.length === 0 || data.length > LIGHT_DATA_MAX) {
    throw new Error(`khub916 light data write needs 1..=${LIGHT_DATA_MAX} bytes, got ${data.length}`);
  }
  const pkt = new Uint8Array(FEATURE_PAYLOAD_BYTES);
  pkt[0] = 10;
  pkt[6] = 0x02;
  pkt.set(data, HEADER_LEN);
  pkt[513] = 0x5a;
  pkt[514] = 0xa5;
  return pkt;
}
