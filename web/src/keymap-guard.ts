/**
 * Whole-table keymap write guard — AGENTS.md §Safety 6/7/8.
 *
 * Every keymap write in the web UI is a read-modify-write of the *whole*
 * u32 table. The base for that write must be a real, complete read:
 * a short, empty, failed or corrupt read must ABORT the write, never be
 * zero-padded into the tail of the table (that silently wipes keys while
 * the read-back verify still passes — the device stored exactly what it
 * was sent).
 *
 * §Safety 7 — unknown tags are OPAQUE. Slots whose high byte the decoder
 * cannot name (e.g. tag `0x08`, the undocumented Fn-layer values on the
 * K1 Pro) are carried through **byte-identical**: the guard validates
 * them as u32 values and passes them, and callers must only ever mutate
 * the slots they intend to change. Nothing here decodes-and-rewrites an
 * opaque slot.
 *
 * This module is DOM-free so `scripts/test-keymap-guard.ts` can run it
 * under plain Node.
 */

import { decodeKeyValue } from './proto/khub916.ts';

export interface KeymapGuardOptions {
  /**
   * Expected slot count when the caller has a trustworthy reference
   * (e.g. the length another arg of the same keyboard reported, or a
   * previously validated read of the same table). Slot count is
   * model-dependent — the K1 Pro reports 126 of the protocol's 128 — so
   * this must come from a real reference, never a constant.
   */
  expectedLen?: number;
  /** Keymap arg (layer | system<<2) for error messages. */
  arg?: number;
}

/**
 * Validate a candidate whole-table keymap base. Returns a normalized
 * copy (`values[i]` as an unsigned u32) on success; throws before any
 * bytes could be sent on:
 *
 * - empty read,
 * - length mismatch vs `expectedLen` (short *or* long — both mean the
 *   read does not describe the table the write would replace),
 * - any slot that is not an integer in `0..=0xFFFFFFFF` (NaN, negative,
 *   fractional, > u32, holes — detectable corruption).
 *
 * Unknown-tag slots (tag `0x08` and any other undecoded high byte) are
 * NOT an error: they pass through verbatim per §Safety 7.
 */
export function guardKeymapBase(
  values: readonly number[],
  opts: KeymapGuardOptions = {},
): number[] {
  const where = opts.arg === undefined ? 'the keymap' : `keymap arg ${opts.arg}`;
  if (values.length === 0) {
    throw new Error(`the keyboard returned an empty ${where} — the read looks incomplete, so nothing was sent`);
  }
  if (opts.expectedLen !== undefined && values.length !== opts.expectedLen) {
    throw new Error(
      `${where} read back ${values.length} keys but ${opts.expectedLen} were expected — ` +
        'the read looks incomplete, so nothing was sent',
    );
  }
  const out = new Array<number>(values.length);
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 0xffff_ffff) {
      throw new Error(
        `${where} slot ${i} holds a corrupt value (${String(v)}) — ` +
          'the read cannot be trusted as a write base, so nothing was sent',
      );
    }
    out[i] = v;
  }
  return out;
}

/**
 * True when a keymap u32 decodes to a tag the protocol does not name —
 * an opaque slot that must be preserved byte-identical (§Safety 7) and
 * must never be offered as an editable bind target. `0` (empty) and all
 * documented tags (`0x00` normal, `0x03` macro, `0x07` secondary, `0x0d`
 * Fn-layer switch, `0x20/0x21/0x22` SOCD/MT/TGL) are NOT opaque.
 */
export function isOpaqueKeymapValue(v: number): boolean {
  if (v === 0) return false;
  return decodeKeyValue(v >>> 0).kind === 'unknown';
}
