/**
 * Shared application state for the khub916 configurator shell.
 *
 * One connected device + one read snapshot (info/power/profile/lights/
 * keymaps) lives here; pages subscribe via `subscribe()` and re-render.
 * READ-ONLY: only query commands are issued (spec §6).
 *
 * This file is a re-export barrel — the implementation is split into
 * domain slices under `./state/` (`core.ts`, `keymap.ts`,
 * `connection.ts`). Existing `import ... from './state.ts'` keeps working.
 */

export * from './state/core.ts';
export * from './state/keymap.ts';
export * from './state/connection.ts';
