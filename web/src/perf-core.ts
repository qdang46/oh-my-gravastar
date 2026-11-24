/**
 * DOM-free helpers for the Performance Studio page (bead `xp0`) —
 * extracted so `scripts/smoke-perf.ts` can exercise them under plain
 * Node (the page module `perf.ts` pulls in `state.ts`/`he.ts`, which
 * Node's strip-only TS mode cannot parse — same split as
 * `diag-core.ts`/`diagnostics.ts`).
 *
 * Range rules mirror `omg kb perf set` / `omg kb hk set`
 * (`crates/omg/src/main.rs` `apply_perf_spec` + the hk params builder)
 * and `crates/model/src/lib.rs`:
 *
 *   - actuation / RT distances: `0 < v ≤ max travel` where max travel
 *     is 3.5 mm for the GravaStar UFO switch (axis id 13232) else 3.4 mm;
 *   - press/release deadzones: `0..=1 mm`;
 *   - `normal_release` is bounded `0..=max travel` (upstream does not
 *     range-check it — the official driver writes 0 — but it is still a
 *     distance, so the UI refuses nonsense before it reaches the wire);
 *   - DKS/MPT deadbands get a conservative UI bound of 0..=3.5 mm
 *     (upstream imposes none; documented here so the page can say so);
 *   - switch echo fields (axis/calibrate/axisV2Id/axisRangeMax/
 *     axisCoefficient) are always carried from the read, never edited.
 *
 * Every HE v2 write this feeds is code-verified, hardware-unverified
 * (docs/protocol-he-v2.md provenance; docs/CAPABILITY-MATRIX.md).
 */

import {
  keycodeBlacklisted,
  MODE_FIXED,
  MODE_RAPID,
  type DksParams,
  type HigherKeyConfig,
  type HigherKeyParams,
  type KeyPerf,
  type KeySlot,
  type LiveKey,
  type MptParams,
} from './proto/he.ts';
import { hidUsageLabel } from './proto/khub916.ts';

// ── Limits (port of crates/model/src/lib.rs actuation section) ────────

/** Switch id of GravaStar's UFO magnetic switch → 3.5 mm max travel. */
export const UFO_SWITCH_ID = 13232;
/** Largest allowed press/release deadzone, mm. */
export const DEADZONE_MAX_MM = 1.0;
/**
 * UI bound for DKS/MPT deadband distances. Upstream (`omg kb hk set`)
 * does not bound them; 3.5 mm is the largest switch travel on any HE
 * board, so anything beyond that cannot be a real deadband.
 */
export const HK_DEADBAND_MAX_MM = 3.5;

/** Max actuation travel for a switch, mm (3.5 UFO / 3.4 otherwise). */
export function maxTravelFor(axisV2Id: number): number {
  return axisV2Id === UFO_SWITCH_ID ? 3.5 : 3.4;
}

// ── Formatting / parsing ───────────────────────────────────────────────

/** `1.5` → `"1.5 mm"`; sub-mm values keep 3 decimals (`0.05 mm`). */
export function fmtMm(v: number): string {
  return `${Number(v.toFixed(3))} mm`;
}

const MM_RE = /^[+-]?(\d+(\.\d+)?|\.\d+)$/;

/** Strict millimetre input: decimal only, finite. Null when invalid. */
export function parseMmInput(s: string): number | null {
  const t = s.trim();
  if (!MM_RE.test(t)) return null;
  const v = Number(t);
  return Number.isFinite(v) ? v : null;
}

/**
 * Keycode input: decimal or `0x`-hex, integer in `0..=0xFFFF`.
 * Null when malformed or out of range. Blacklist is a separate check
 * (`keycodeError`) so the UI can say *why* a value was refused.
 */
export function parseKcInput(s: string): number | null {
  const t = s.trim();
  let v: number;
  if (/^0x[0-9a-fA-F]+$/.test(t)) v = parseInt(t.slice(2), 16);
  else if (/^\d+$/.test(t)) v = parseInt(t, 10);
  else return null;
  return Number.isInteger(v) && v >= 0 && v <= 0xffff ? v : null;
}

/** Why a parsed keycode may not be written, or null when it may. */
export function keycodeError(code: number): string | null {
  if (code < 0 || code > 0xffff || !Number.isInteger(code)) {
    return `keycode 0x${(code >>> 0).toString(16).toUpperCase().padStart(4, '0')} is out of range`;
  }
  if (keycodeBlacklisted(code)) {
    return (
      `keycode 0x${code.toString(16).toUpperCase().padStart(4, '0')} is blacklisted — ` +
      'it triggers a device-level function (factory reset / calibration), never assign it'
    );
  }
  return null;
}

/** Legend for an HE keycode (HID usage space, English table). */
export function heKeyLabel(code: number): string {
  const label = hidUsageLabel(code);
  if (label === '') return '·';
  // `hidUsageLabel` falls back to bare hex for unnamed usages — prefix
  // those with 0x so they read as codes, not letters ('700' vs '0x700').
  const hex = code.toString(16).toUpperCase();
  return label === hex && code > 0x45 ? `0x${hex}` : label;
}

// ── Keyboard geometry (port of crates/model `key_size` + `build_layout`) ──

/** Key-unit → px scale; a 1u key is 44 px (same as the khub916 layout). */
export const KEY_UNIT_PX = 44;

/**
 * Width/height in key units for a `03 05` size code.
 * Port of `omg_model::key_size` — code 11 is the ISO Enter (1.5u × 2u,
 * `isoEnter` flag kept for callers that want the split rendering).
 */
export function keySizeWH(size: number): { w: number; h: number; isoEnter: boolean } {
  switch (size) {
    case 2: return { w: 1.25, h: 1.0, isoEnter: false };
    case 3: return { w: 1.5, h: 1.0, isoEnter: false };
    case 4: return { w: 1.75, h: 1.0, isoEnter: false };
    case 5: return { w: 2.0, h: 1.0, isoEnter: false };
    case 6: return { w: 2.25, h: 1.0, isoEnter: false };
    case 7: return { w: 2.5, h: 1.0, isoEnter: false };
    case 8: return { w: 2.75, h: 1.0, isoEnter: false };
    case 9: return { w: 6.25, h: 1.0, isoEnter: false };
    case 10: return { w: 1.0, h: 2.0, isoEnter: false };
    case 11: return { w: 1.5, h: 2.0, isoEnter: true };
    default: return { w: 1.0, h: 1.0, isoEnter: false };
  }
}

export interface HeGridCell {
  row: number;
  col: number;
  /** px position/size inside the canvas (key units × KEY_UNIT_PX). */
  x: number;
  y: number;
  w: number;
  h: number;
  size: number;
  isoEnter: boolean;
}

export interface HeGrid {
  width: number;
  height: number;
  cells: HeGridCell[];
}

/**
 * Lay out `03 05` slots into a px canvas. Y is normalised so the topmost
 * key sits at 0 (firmware rows may start above row 0's origin).
 */
export function layoutKeyGrid(slots: readonly KeySlot[]): HeGrid {
  if (slots.length === 0) return { width: 0, height: 0, cells: [] };
  const top = Math.min(...slots.map((s) => s.y));
  const cells: HeGridCell[] = slots.map((s) => {
    const { w, h, isoEnter } = keySizeWH(s.size);
    return {
      row: s.row,
      col: s.col,
      x: s.x * KEY_UNIT_PX,
      y: (s.y - top) * KEY_UNIT_PX,
      w: w * KEY_UNIT_PX,
      h: h * KEY_UNIT_PX,
      size: s.size,
      isoEnter,
    };
  });
  const width = Math.max(...cells.map((c) => c.x + c.w));
  const height = Math.max(...cells.map((c) => c.y + c.h));
  return { width, height, cells };
}

// ── Performance draft (actuation / RT / deadzones) ─────────────────────

/**
 * Editable subset of `KeyPerf`. The switch echo fields are NOT here —
 * `applyPerfDraft` carries them from the read untouched.
 */
export interface PerfDraft {
  /** 0 = fixed actuation, 1 = rapid trigger (`MODE_FIXED`/`MODE_RAPID`). */
  mode: number;
  normalPress: number;
  normalRelease: number;
  rtFirstTouch: number;
  rtPress: number;
  rtRelease: number;
  pressDeadzone: number;
  releaseDeadzone: number;
}

export function draftFromPerf(p: KeyPerf): PerfDraft {
  return {
    mode: p.mode,
    normalPress: p.normalPress,
    normalRelease: p.normalRelease,
    rtFirstTouch: p.rtFirstTouch,
    rtPress: p.rtPress,
    rtRelease: p.rtRelease,
    pressDeadzone: p.pressDeadzone,
    releaseDeadzone: p.releaseDeadzone,
  };
}

/** Merge a draft over a freshly-read `KeyPerf` (echoes preserved). */
export function applyPerfDraft(base: KeyPerf, d: PerfDraft): KeyPerf {
  return { ...base, ...d };
}

const EPS = 0.0005;

function finite(v: number): boolean {
  return Number.isFinite(v);
}

/**
 * Validate a draft against the switch limits — same rules as
 * `omg kb perf set` (`apply_perf_spec`), plus a `0..=max travel` bound on
 * `normal_release` (a distance upstream leaves unchecked). Returns a
 * human-readable reason, or null when the draft may be sent.
 */
export function validatePerfDraft(base: KeyPerf, d: PerfDraft): string | null {
  if (d.mode !== MODE_FIXED && d.mode !== MODE_RAPID) {
    return `mode must be ${MODE_FIXED} (fixed) or ${MODE_RAPID} (rapid trigger)`;
  }
  const limit = maxTravelFor(base.axisV2Id);
  const fields: [string, number][] = [
    ['actuation point', d.mode === MODE_FIXED ? d.normalPress : d.rtFirstTouch],
    ['RT first touch', d.rtFirstTouch],
    ['RT press sensitivity', d.rtPress],
    ['RT release sensitivity', d.rtRelease],
  ];
  for (const [name, v] of fields) {
    if (!finite(v)) return `${name} is not a number`;
    if (!(v > 0 && v <= limit)) {
      return `${name} ${fmtMm(v)} out of range for this switch (0 < v ≤ ${limit} mm)`;
    }
  }
  if (!finite(d.normalRelease) || !(d.normalRelease >= 0 && d.normalRelease <= limit)) {
    return `release point ${fmtMm(d.normalRelease)} out of range (0..=${limit} mm)`;
  }
  if (!finite(d.normalPress) || !(d.normalPress > 0 && d.normalPress <= limit)) {
    return `normal press ${fmtMm(d.normalPress)} out of range for this switch (0 < v ≤ ${limit} mm)`;
  }
  for (const [name, v] of [
    ['press deadzone', d.pressDeadzone],
    ['release deadzone', d.releaseDeadzone],
  ] as [string, number][]) {
    if (!finite(v)) return `${name} is not a number`;
    if (!(v >= 0 && v <= DEADZONE_MAX_MM)) {
      return `${name} ${fmtMm(v)} out of range 0..=${DEADZONE_MAX_MM} mm`;
    }
  }
  return null;
}

/** Human-readable diff lines between two perf settings (for the confirm). */
export function perfChanges(base: KeyPerf, next: KeyPerf): string[] {
  const out: string[] = [];
  const modeName = (m: number) => (m === MODE_RAPID ? 'rapid trigger' : 'fixed');
  if (base.mode !== next.mode) {
    out.push(`mode: ${modeName(base.mode)} → ${modeName(next.mode)}`);
  }
  const pairs: [string, number, number][] = [
    ['actuation point', base.normalPress, next.normalPress],
    ['release point', base.normalRelease, next.normalRelease],
    ['RT first touch', base.rtFirstTouch, next.rtFirstTouch],
    ['RT press sensitivity', base.rtPress, next.rtPress],
    ['RT release sensitivity', base.rtRelease, next.rtRelease],
    ['press deadzone', base.pressDeadzone, next.pressDeadzone],
    ['release deadzone', base.releaseDeadzone, next.releaseDeadzone],
  ];
  for (const [name, a, b] of pairs) {
    if (Math.abs(a - b) > EPS) out.push(`${name}: ${fmtMm(a)} → ${fmtMm(b)}`);
  }
  return out.length > 0 ? out : ['no effective change'];
}

// ── HigherKey (DKS / MPT) ──────────────────────────────────────────────

/** The advanced-key modes this page can edit (cat-6 modes 1 and 2). */
export const HK_EDITABLE_MODES = ['none', 'dks', 'mpt'] as const;
export type HkEditableMode = (typeof HK_EDITABLE_MODES)[number];

function kcList(kcs: readonly number[]): string {
  return kcs.map((c) => `0x${c.toString(16).toUpperCase().padStart(4, '0')}`).join(', ');
}

/** One-line description of any decoded HigherKey config (read display). */
export function hkConfigSummary(cfg: HigherKeyConfig): string {
  switch (cfg.mode) {
    case 'none':
      return 'none — normal key';
    case 'dks':
      return `DKS — keycodes [${kcList(cfg.params.kcs)}], trigger points [${cfg.params.trps.join(', ')}], deadbands [${cfg.params.dbs.map(fmtMm).join(', ')}]`;
    case 'mpt':
      return `MPT — keycodes [${kcList(cfg.params.kcs)}], deadbands [${cfg.params.dbs.map(fmtMm).join(', ')}]`;
    case 'mt':
      return `MT (tap-or-hold) — keycodes [${kcList(cfg.params.kcs)}], time ${cfg.params.time} (raw units, unverified)`;
    case 'tgl':
      return `TGL (toggle) — keycode 0x${cfg.params.kcs.toString(16).toUpperCase().padStart(4, '0')}, time ${cfg.params.time} (raw units, unverified)`;
    case 'end':
      return `END — keycodes [${kcList(cfg.params.kcs)}], delay ${cfg.params.delay}`;
    case 'socd':
      return `SOCD — partner r${cfg.params.row2}c${cfg.params.col2}, direction ${cfg.params.direction}`;
    case 'rs':
      return `RS — partner r${cfg.params.row2}c${cfg.params.col2}, delay ${cfg.params.delay}`;
  }
}

/**
 * Validate a DKS/MPT draft. `kcs` are parsed keycodes, `nums` the
 * mode's numeric fields in wire order (dks: 4 trigger bytes + 2
 * deadbands; mpt: 3 deadbands). Returns an error string or null.
 */
export function hkDraftError(
  mode: HkEditableMode,
  kcs: readonly number[],
  nums: readonly number[],
): string | null {
  if (mode === 'none') return null;
  const needKcs = mode === 'dks' ? 4 : 3;
  const needNums = mode === 'dks' ? 6 : 3;
  if (kcs.length !== needKcs) return `${mode.toUpperCase()} needs exactly ${needKcs} keycodes, got ${kcs.length}`;
  if (nums.length !== needNums) return `${mode.toUpperCase()} needs exactly ${needNums} numeric values, got ${nums.length}`;
  for (const kc of kcs) {
    const err = keycodeError(kc);
    if (err) return err;
  }
  if (mode === 'dks') {
    for (let i = 0; i < 4; i++) {
      const t = nums[i] ?? NaN;
      if (!Number.isInteger(t) || t < 0 || t > 255) {
        return `DKS trigger point ${i + 1} must be a whole number 0–255, got ${nums[i]}`;
      }
    }
    for (let i = 4; i < 6; i++) {
      const db = nums[i] ?? NaN;
      if (!Number.isFinite(db) || !(db >= 0 && db <= HK_DEADBAND_MAX_MM)) {
        return `DKS deadband ${i - 3} ${fmtMm(db)} out of range 0..=${HK_DEADBAND_MAX_MM} mm`;
      }
    }
  } else {
    for (let i = 0; i < 3; i++) {
      const db = nums[i] ?? NaN;
      if (!Number.isFinite(db) || !(db >= 0 && db <= HK_DEADBAND_MAX_MM)) {
        return `MPT deadband ${i + 1} ${fmtMm(db)} out of range 0..=${HK_DEADBAND_MAX_MM} mm`;
      }
    }
  }
  return null;
}

/** Build the write-side params for a validated DKS/MPT draft. */
export function buildHkParams(
  mode: 'dks' | 'mpt',
  kcs: readonly number[],
  nums: readonly number[],
): HigherKeyParams {
  if (mode === 'dks') {
    const params: DksParams = {
      kcs: [kcs[0] ?? 0, kcs[1] ?? 0, kcs[2] ?? 0, kcs[3] ?? 0],
      trps: [nums[0] ?? 0, nums[1] ?? 0, nums[2] ?? 0, nums[3] ?? 0],
      dbs: [nums[4] ?? 0, nums[5] ?? 0],
    };
    return { mode: 'dks', params };
  }
  const params: MptParams = {
    kcs: [kcs[0] ?? 0, kcs[1] ?? 0, kcs[2] ?? 0],
    dbs: [nums[0] ?? 0, nums[1] ?? 0, nums[2] ?? 0],
  };
  return { mode: 'mpt', params };
}

// ── Live travel ────────────────────────────────────────────────────────

/**
 * Fill fraction 0..1 of a key's travel bar for the monitor grid.
 * Clamped — firmware can report noise above the switch's max travel.
 */
export function travelFill(travelMm: number, maxTravel: number): number {
  if (!Number.isFinite(travelMm) || maxTravel <= 0) return 0;
  return Math.min(1, Math.max(0, travelMm / maxTravel));
}

/** Summarise one live row for the monitor status line. */
export function liveRowSummary(keys: readonly LiveKey[]): string {
  const down = keys.filter((k) => k.actuated).length;
  const max = keys.reduce((m, k) => Math.max(m, k.travelMm), 0);
  return `${down} actuated · deepest ${Number(max.toFixed(2))} mm`;
}
