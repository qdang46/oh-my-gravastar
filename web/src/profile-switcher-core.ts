/**
 * profile-switcher-core.ts — bead 0hl, PURE half: the game/app profile
 * switcher model. No DOM, no device access, no writes — safe to unit
 * test under `node scripts/test-profile-switcher.ts`.
 *
 * A "saved profile" here is a named `ProfileHistoryEntry` (see
 * profile-history.ts / profiles.ts) — the same schema-v1 snapshot the
 * Version history card manages. This module adds:
 *
 *   - `profileDocMeta()` / `profileCompatOf()` — the per-profile
 *     compatibility badge (name/model shown in the list, ok/warning/
 *     error verdict via core/compatibility.ts, same split as
 *     profile-import.ts: protocol mismatch = error, model mismatch =
 *     warning the apply path confirms separately);
 *   - `buildProfileList()` — list model for the picker UI;
 *   - `ProfileSwitcherStore` — localStorage record of which profile is
 *     "active" plus a bounded switch history (`omg.profiles.switcher.v1`).
 *
 * PLATFORM LIMIT (bead 0hl): a browser page cannot detect the
 * foreground app/game, so there is deliberately NO auto-switch trigger
 * here — switching is manual. The CLI-side `omg profile watch` trigger
 * is planned follow-up work; nothing in this file pretends otherwise.
 */

import { canApplyProfile } from './core/compatibility.ts';
import type { DeviceLike } from './core/device-model.ts';
import {
  memoryProfileStorage,
  sectionsInState,
  stateOfDoc,
  type ProfileHistoryEntry,
  type ProfileStorage,
} from './profile-history.ts';

function isRec(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// ── Profile document metadata + compatibility ─────────────────────────

export interface ProfileDocMeta {
  /** `devices[i].protocol` (e.g. 'khub916'), when declared. */
  protocol: string | null;
  /** `devices[i].model` — 'unknown' is normalised to null. */
  model: string | null;
  /** `state.device_info.catalog_model` (vendor catalog id), when present. */
  catalogModel: string | null;
  /** True when the doc carries a restorable `state` object. */
  hasState: boolean;
}

/**
 * Tolerant schema-v1 metadata extraction for the picker list — same
 * device/profile selection rules as `stateOfDoc` / `khub916StateOfDoc`
 * (khub916 device preferred, else first; profile named "current",
 * else first) but never throws: unknown shapes yield null fields.
 */
export function profileDocMeta(doc: unknown): ProfileDocMeta | null {
  if (!isRec(doc)) return null;
  const devices = doc.devices;
  if (!Array.isArray(devices) || devices.length === 0) return null;
  const dev = devices.find((d) => isRec(d) && d.protocol === 'khub916') ?? devices[0];
  if (!isRec(dev)) return null;

  const profiles = dev.profiles;
  const prof = (
    Array.isArray(profiles)
      ? profiles.find((p) => isRec(p) && p.name === 'current') ?? profiles[0]
      : undefined
  ) as Record<string, unknown> | undefined;
  const state = isRec(prof?.state) ? prof.state : null;

  const devInfo = state && isRec(state.device_info) ? state.device_info : undefined;
  const model =
    typeof dev.model === 'string' && dev.model !== 'unknown' ? dev.model : null;
  const catalogModel =
    devInfo && typeof devInfo.catalog_model === 'string' ? devInfo.catalog_model : null;
  return {
    protocol: typeof dev.protocol === 'string' ? dev.protocol : null,
    model,
    catalogModel,
    hasState: state !== null,
  };
}

export type CompatStatus = 'ok' | 'warning' | 'error' | 'unknown';

export interface ProfileCompat {
  status: CompatStatus;
  /** Blocking problems (protocol mismatch, no state, foreign doc). */
  errors: string[];
  /** Non-blocking problems (model mismatch — apply asks to confirm). */
  warnings: string[];
}

const NO_CHECK: ProfileCompat = { status: 'unknown', errors: [], warnings: [] };

/**
 * Compatibility verdict for one saved profile against the connected
 * device. Mirrors the import gate in profile-import.ts
 * (`planProfileImport`): the protocol check produces blocking errors,
 * the model/catalog check produces overridable warnings. `device` must
 * be non-null — callers without a connection use `NO_CHECK`-style
 * 'unknown' status via `buildProfileList`.
 */
export function profileCompatOf(device: DeviceLike, doc: unknown): ProfileCompat {
  const meta = profileDocMeta(doc);
  if (!meta) {
    return {
      status: 'error',
      errors: ['not a recognizable profile document'],
      warnings: [],
    };
  }
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!meta.hasState) {
    errors.push('the snapshot holds no keyboard state to restore');
  }
  if (meta.protocol) {
    errors.push(...canApplyProfile(device, { protocol: meta.protocol }).reasons);
  }
  if (meta.model || meta.catalogModel) {
    warnings.push(
      ...canApplyProfile(device, {
        ...(meta.model ? { model: meta.model } : {}),
        ...(meta.catalogModel ? { catalogModel: meta.catalogModel } : {}),
      }).reasons,
    );
  }
  return {
    status: errors.length ? 'error' : warnings.length ? 'warning' : 'ok',
    errors,
    warnings,
  };
}

export function unknownCompat(): ProfileCompat {
  return { status: 'unknown', errors: [], warnings: [] };
}

// ── List model ────────────────────────────────────────────────────────

export interface ProfileListItem {
  id: string;
  name: string;
  /** ISO-8601 capture time. */
  ts: string;
  /** Device model the profile was captured on (null = unknown). */
  model: string | null;
  /** Number of restorable sections in the snapshot. */
  sections: number;
  compat: ProfileCompat;
}

/**
 * Build picker rows from history entries (already newest-first).
 * `device === null` (disconnected) yields 'unknown' compat — the list
 * still renders, Apply stays disabled.
 */
export function buildProfileList(
  entries: readonly ProfileHistoryEntry[],
  device: DeviceLike | null,
): ProfileListItem[] {
  return entries.map((e) => {
    const meta = profileDocMeta(e.doc);
    const state = stateOfDoc(e.doc);
    return {
      id: e.id,
      name: e.name,
      ts: e.ts,
      model: meta?.model ?? meta?.catalogModel ?? null,
      sections: sectionsInState(state).length,
      compat: device ? profileCompatOf(device, e.doc) : unknownCompat(),
    };
  });
}

// ── Active profile + switch history (localStorage) ────────────────────

export type SwitchOutcome = 'applied' | 'failed' | 'cancelled';

export interface ProfileSwitchRecord {
  /** ISO-8601 time the apply was attempted. */
  ts: string;
  profileId: string;
  name: string;
  outcome: SwitchOutcome;
}

export interface ProfileSwitcherState {
  /** `ProfileHistoryEntry.id` of the profile the keyboard was last set to. */
  activeId: string | null;
  /** Bounded, newest-first apply log. */
  switches: ProfileSwitchRecord[];
}

export const PROFILE_SWITCHER_KEY = 'omg.profiles.switcher.v1';
export const SWITCH_HISTORY_MAX = 50;

function defaultStorage(): ProfileStorage {
  try {
    if (typeof localStorage !== 'undefined') return localStorage;
  } catch {
    // opaque origins can throw on access
  }
  return memoryProfileStorage();
}

function isOutcome(v: unknown): v is SwitchOutcome {
  return v === 'applied' || v === 'failed' || v === 'cancelled';
}

function isSwitchRecord(v: unknown): v is ProfileSwitchRecord {
  return (
    isRec(v) &&
    typeof v.ts === 'string' &&
    typeof v.profileId === 'string' &&
    typeof v.name === 'string' &&
    isOutcome(v.outcome)
  );
}

function isState(v: unknown): v is ProfileSwitcherState {
  return (
    isRec(v) &&
    (v.activeId === null || typeof v.activeId === 'string') &&
    Array.isArray(v.switches)
  );
}

/**
 * Which saved profile is "active" + the bounded apply log. Stored as one
 * JSON document in localStorage; malformed content resets to empty
 * rather than throwing (same tolerance as ProfileHistory).
 */
export class ProfileSwitcherStore {
  private readonly storage: ProfileStorage;
  private state: ProfileSwitcherState | null = null;

  constructor(storage: ProfileStorage = defaultStorage()) {
    this.storage = storage;
  }

  private load(): ProfileSwitcherState {
    if (this.state) return this.state;
    try {
      const raw = this.storage.getItem(PROFILE_SWITCHER_KEY);
      const parsed: unknown = raw ? JSON.parse(raw) : null;
      this.state = isState(parsed)
        ? { activeId: parsed.activeId, switches: parsed.switches.filter(isSwitchRecord) }
        : { activeId: null, switches: [] };
    } catch {
      this.state = { activeId: null, switches: [] };
    }
    return this.state;
  }

  private persist(): void {
    this.storage.setItem(PROFILE_SWITCHER_KEY, JSON.stringify(this.load()));
  }

  activeId(): string | null {
    return this.load().activeId;
  }

  setActive(id: string | null): void {
    const s = this.load();
    if (s.activeId === id) return;
    s.activeId = id;
    this.persist();
  }

  switches(): readonly ProfileSwitchRecord[] {
    return this.load().switches;
  }

  recordSwitch(rec: ProfileSwitchRecord): void {
    const s = this.load();
    s.switches.unshift(rec);
    if (s.switches.length > SWITCH_HISTORY_MAX) s.switches.length = SWITCH_HISTORY_MAX;
    this.persist();
  }

  clear(): void {
    const s = this.load();
    s.activeId = null;
    s.switches.length = 0;
    this.persist();
  }
}
