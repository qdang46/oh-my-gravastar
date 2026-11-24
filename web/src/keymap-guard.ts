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

/**
 * Indices of the slots in `values` that decode to an unknown tag —
 * the opaque slots of §Safety 7. Used by the remap page to refuse edits
 * and whole-table copies that would overwrite them.
 */
export function opaqueKeymapSlots(values: readonly number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < values.length; i++) {
    if (isOpaqueKeymapValue(values[i] ?? 0)) out.push(i);
  }
  return out;
}

/**
 * Lock reason shown when a whole keymap arg must not be edited, or null
 * when edits may proceed. Wraps [`guardKeymapBase`] for *cached* reads
 * (display-time gating in `remap.ts`): `values` are the u32s already in
 * `app.snapshot.keymaps`, `siblingLengths` the slot counts other args of
 * the same keyboard reported (the fixed-count cross-check `keymapBase`
 * performs). An absent/never-read arg is the caller's job — pass only
 * real reads here; an empty read IS an error.
 */
export function keymapReadError(
  arg: number,
  values: readonly number[],
  siblingLengths: readonly number[] = [],
): string | null {
  try {
    guardKeymapBase(values, { arg, expectedLen: siblingLengths.find((n) => n > 0) });
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

/**
 * True for keymap args with the system bit set (`arg & 4` — the vendor's
 * Win/Mac `systemModel` selector, packed as `layer & 3 | system << 2`).
 */
export function isSystemKeymapArg(arg: number): boolean {
  return (arg & 4) !== 0;
}

/**
 * Args 4–7 are NOT editable in this UI (bead
 * oh-my-gravastar-remap-opaque-slots-nw5). The wire encoding itself is
 * code-verified against the vendor JS (`getKeyboardKeys` sends
 * `[131, layer&3 | (system&1)<<2, 0,1,0,248,1]`), but live reads on the
 * K1 Pro return a differently-framed payload — the `5A A5` write marker
 * lands mid-table and u32s come back byte-rotated (`0x29000000` vs
 * `0x00000029`) — so the guard cannot vouch for the contents and a
 * "verified" write-back would only prove the device stored the garbage
 * it was sent. Locked until the system-arg read shape is understood.
 */
export const SYSTEM_KEYMAP_ARGS_TRUSTED = false;

/** Human explanation for the system-arg lock (toggle tooltip/status). */
export const SYSTEM_ARG_LOCK_REASON =
  'the keyboard does not return a readable key table for the system-variant ' +
  'key sets (args 4–7) — the read comes back garbled, so editing is disabled ' +
  'until the encoding is understood';
