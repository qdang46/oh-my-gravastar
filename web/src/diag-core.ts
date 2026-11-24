/**
 * DOM-free helpers for the Diagnostics page (bead `oq2`) — extracted so
 * `scripts/smoke-diag.ts` can exercise them under plain Node (the page
 * module itself pulls in `state.ts` → `hid.ts`, which uses constructor
 * parameter properties that Node's strip-only TS mode cannot parse).
 *
 * Boot keyboard report decoding follows the USB HID spec "boot
 * protocol" keyboard format: byte 0 = modifier bitmap, byte 1 =
 * reserved, bytes 2..7 = up to 6 pressed keycodes (HID usage ids).
 * khub916 does not document per-key input on its vendor
 * feature-report channel, so the page treats these as whatever the
 * keyboard's standard HID interface emits; non-8-byte reports are
 * counted as unrecognised, never decoded.
 */

import { decodeKeyValue } from './proto/khub916.ts';

/** Modifier bit index → HID usage id (0xE0..0xE7). */
const MOD_USAGE_BASE = 0xe0;

export const MODIFIER_LABELS: Record<number, string> = {
  0xe0: 'Left Ctrl',
  0xe1: 'Left Shift',
  0xe2: 'Left Alt',
  0xe3: 'Left GUI',
  0xe4: 'Right Ctrl',
  0xe5: 'Right Shift',
  0xe6: 'Right Alt',
  0xe7: 'Right GUI',
};

export interface BootKeyState {
  /** Modifier bitmap byte (bits 0..7, L→R order per HID spec). */
  modifiers: number;
  /** Modifier usages currently down (0xE0..0xE7). */
  modUsages: number[];
  /** Pressed key usages (HID usage ids, boot slots only). */
  usages: number[];
}

/**
 * Decode an 8-byte boot keyboard report. Returns null for any other
 * length — callers count those as unrecognised vendor/NKRO traffic.
 */
export function decodeBootKeyboardReport(data: Uint8Array): BootKeyState | null {
  if (data.length !== 8) return null;
  const modifiers = data[0] ?? 0;
  const modUsages: number[] = [];
  for (let bit = 0; bit < 8; bit++) {
    if (modifiers & (1 << bit)) modUsages.push(MOD_USAGE_BASE + bit);
  }
  const usages: number[] = [];
  for (let i = 2; i < 8; i++) {
    const u = data[i] ?? 0;
    if (u !== 0) usages.push(u);
  }
  return { modifiers, modUsages, usages };
}

/**
 * HID usages a khub916 keymap value "presses" in boot-report terms.
 * `normal` values contribute their usage plus left-modifier usages for
 * set modifier bits; every other kind (macro/Fn/SOCD/…) contributes
 * nothing — those keys cannot be matched to a physical press.
 */
export function pressTokensForValue(v: number): number[] {
  const kv = decodeKeyValue(v >>> 0);
  if (kv.kind !== 'normal') return [];
  const tokens: number[] = [];
  if (kv.usage !== 0) tokens.push(kv.usage);
  if (kv.ctrl) tokens.push(0xe0);
  if (kv.shift) tokens.push(0xe1);
  if (kv.alt) tokens.push(0xe2);
  if (kv.gui) tokens.push(0xe3);
  return tokens;
}

/** Lowercase-free uppercase hex dump for unrecognised reports. */
export function hexBytes(bytes: Uint8Array, max = 96): string {
  const slice = bytes.subarray(0, max);
  const s = Array.from(slice, (x) => x.toString(16).padStart(2, '0')).join(' ');
  return bytes.length > max ? `${s} …` : s;
}
