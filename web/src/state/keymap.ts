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

export async function setLayer(layer: number): Promise<void> {
  app.layer = layer & 3;
  emit();
  try {
    await ensureKeymap(app.layer);
  } catch (e) {
    setStatus(`Could not read the keymap: ${e instanceof Error ? e.message : String(e)}`, true);
  }
}
