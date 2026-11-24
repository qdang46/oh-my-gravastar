/**
 * Keymap slice of the shared application state — layer selection and
 * per-layer decoded-keymap cache (`app.snapshot.keymaps`).
 */

import { app, emit, setStatus, type KeyEntry } from './core.ts';

// ── Keymap ─────────────────────────────────────────────────────────────

/** Fetch + cache the decoded keymap for one arg. No-op when cached. */
export async function ensureKeymap(arg: number): Promise<KeyEntry[]> {
  const snap = app.snapshot;
  if (!snap || !app.connected) return [];
  const cached = snap.keymaps.get(arg);
  if (cached) return cached;
  const keys = await app.connected.session.keymap(arg);
  snap.keymaps.set(arg, keys);
  emit();
  return keys;
}

/**
 * Keymap values for a read-modify-write, or throw — never a guessed base.
 *
 * AGENTS.md §Safety 6: a whole-table write must not be built on a short or
 * empty read. `writeKeymap`'s own length check only rejects an empty list,
 * so a *short* read (say 60 of 126 slots) sails through and the tail is
 * padded with zeros — silently wiping it while the read-back verify still
 * passes, because the device stored exactly what was sent.
 *
 * The device reports one fixed slot count per model for every arg (K1 Pro:
 * 126), so a differing count across args means a partial read. Args are
 * cross-checked against each other; the first read of a session has no
 * reference and is only required to be non-empty.
 */
export async function keymapBase(arg: number): Promise<number[]> {
  const values = (await ensureKeymap(arg)).map((e) => e.value);
  if (values.length === 0) {
    throw new Error('the keyboard returned an empty key set — nothing was sent');
  }
  const reference = [...(app.snapshot?.keymaps ?? new Map())]
    .filter(([a]) => a !== arg)
    .map(([, entries]) => entries.length)
    .find((n) => n > 0);
  if (reference !== undefined && values.length !== reference) {
    throw new Error(
      `this key set read back ${values.length} keys but the keyboard reports ${reference} ` +
        'for its other key sets — the read looks incomplete, so nothing was sent',
    );
  }
  return values;
}

export async function setLayer(layer: number): Promise<void> {
  app.layer = layer & 3;
  emit();
  try {
    await ensureKeymap(app.layer);
  } catch (e) {
    setStatus(`Could not read the keymap: ${e instanceof Error ? e.message : String(e)}`, true);
  }
}
