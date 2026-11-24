/**
 * profile-import.ts — bead ra1: PURE half of schema-v1 profile import.
 *
 * `planProfileImport()` turns a parsed schema-v1 backup document's khub916
 * `state` into the list of writable sections `applyParsedImport`
 * (pages-secondary.ts) executes through `runTransaction`. It is DOM-free
 * and device-free: the connected session's write methods are injected as
 * a structural `ProfileImportWriter`, the compatibility gate runs on a
 * `DeviceLike`, and live values needed for safe merging (the 126 colour
 * slots, the current profile blob) are passed in — so the whole mapping
 * is smoke-tested under `node scripts/smoke-import.ts`.
 *
 * Section → write mapping (docs/protocol-khub916.md §6 — only the
 * already-implemented, read-back-verified commands; cmd 17 reset and the
 * other `→` writes stay blacklisted per AGENTS.md §2):
 *
 *   state.keymap        → cmd 3 `writeKeymap` per arg 0–7
 *                         (arg = layer&3 | system<<2 — all 4 layers ×
 *                         both system bits, matching `khub916_state`)
 *   state.light_colors  → cmd 6 `writeCustomLightColors` (126 slots,
 *                         gaps filled from the live device)
 *   state.light_data_hex→ cmd 10 `writeLightData`
 *   state.macro_hex     → cmd 5 `writeMacroRegion`
 *   state.profile       → cmd 4 `writeProfile`: the exported blob
 *                         verbatim when `hex` is present (length must
 *                         match the connected device's blob), else a
 *                         patch of the CURRENT blob with the file's
 *                         `sleep_seconds` / `light_mode` fields
 *
 * `device_info` / `power` are read-only export data — reported in
 * `skipped`, never written.
 */

import { canApplyProfile } from './core/compatibility.ts';
import type { DeviceLike } from './core/device-model.ts';
import {
  decodeLightState,
  withLightMode,
  CUSTOM_LIGHT_SLOTS,
  LIGHT_DATA_MAX,
  type Rgb,
} from './proto/light.ts';
import { MACRO_REGION_BYTES } from './proto/macro916.ts';
import {
  FEATURE_PAYLOAD_BYTES,
  HEADER_LEN,
  profileWithSleepSeconds,
} from './proto/khub916.ts';
import type { WriteOutcomeLike } from './safety/transaction.ts';
import type { OpType } from './safety/policy.ts';
import type { SnapshotSectionName } from './safety/snapshots.ts';
import { hexToBytes, validateKeymapSection } from './safety/validation.ts';

// ── Shared types (consumed by pages-secondary.ts / profiles.ts) ───────

/** Result of one applied import section (for the journal/report). */
export interface SectionOutcome {
  /** Human-readable result line, e.g. `saved (set 1 ✓, set 2)`. */
  text: string;
  /** False when the write was sent but read-back did not confirm it. */
  verified: boolean;
}

export interface ImportSection {
  name: string;
  /** Human-readable summary shown in the preview. */
  summary: string;
  /** Policy op type for the transaction journal (safety/policy.ts). */
  opType: OpType;
  /**
   * Snapshot section (safety/snapshots.ts) this import part maps to —
   * used for the best-effort rollback after a partial failure (R2).
   * Two import parts may share one snapshot section (the two lighting
   * writes both restore from `lighting`).
   */
  snapSection?: SnapshotSectionName;
  /** Apply this section; returns a result line + verify flag. */
  apply: () => Promise<SectionOutcome>;
}

export interface ParsedImport {
  fileName: string;
  model: string;
  sections: ImportSection[];
  skipped: string[];
  /**
   * Compatibility problems that forbid the import (e.g. the backup was
   * made for a different protocol). When non-empty no apply UI is shown.
   */
  compatErrors: string[];
  /**
   * Compatibility warnings the user may override after an explicit
   * confirm (e.g. the backup targets a different keyboard model).
   */
  compatWarnings: string[];
}

/**
 * Write side of the connected khub916 session — satisfied structurally
 * by `Khub916Session` (hid.ts). Every method is optional: an absent
 * method downgrades its section to a "pending" skip instead of failing.
 */
export interface ProfileImportWriter {
  writeKeymap?(
    layer: number,
    system: number,
    values: readonly number[],
  ): Promise<WriteOutcomeLike>;
  writeCustomLightColors?(colors: readonly Rgb[]): Promise<WriteOutcomeLike>;
  writeLightData?(data: Uint8Array): Promise<WriteOutcomeLike>;
  writeMacroRegion?(data: Uint8Array): Promise<WriteOutcomeLike>;
  writeProfile?(blob: Uint8Array): Promise<WriteOutcomeLike>;
}

/** Everything `planProfileImport` needs that used to come from `app`. */
export interface ProfileImportContext {
  /**
   * Connected-device identity for the compatibility gate — HID ids plus
   * the cmd-130 identity (uuid/catalog/screen) from the snapshot.
   */
  device: DeviceLike;
  /** Session write methods (see ProfileImportWriter). */
  writer: ProfileImportWriter;
  /**
   * Live 126-slot custom colours from the snapshot — fills gaps when the
   * file only carries a subset of `light_colors`.
   */
  liveColors?: readonly Rgb[];
  /**
   * Current device profile blob (snapshot raw). Used for the strict
   * length check on a verbatim `profile.hex` write and as the base for
   * the `sleep_seconds`/`light_mode` field patch when no blob is in the
   * file. Absent → the profile section is skipped honestly.
   */
  currentProfile?: Uint8Array;
}

// ── Internals ──────────────────────────────────────────────────────────

const PENDING = 'not available in this version yet';
/** Profile blob cap: feature payload minus the 7-byte header (512 B). */
const PROFILE_HEX_MAX = FEATURE_PAYLOAD_BYTES - HEADER_LEN;
/** `profile[24]` sleep field + `profile[9..10]` light mode need ≥25 B. */
const PROFILE_MIN_BYTES = 25;

function isRec(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Verified flag of a write outcome; `verified === false` → unverified. */
function verifiedOf(out: WriteOutcomeLike | void): boolean {
  return out?.verified !== false;
}

function savedText(out: WriteOutcomeLike | void, verb = 'saved'): string {
  return verifiedOf(out) ? `${verb} and checked` : verb;
}

/**
 * Extract the khub916 `state` object from a schema-v1 document — same
 * selection rules as `profile-history.ts::stateOfDoc` but stricter: the
 * device entry MUST declare `protocol: "khub916"`.
 */
export function khub916StateOfDoc(doc: unknown): {
  dev: Record<string, unknown>;
  state: Record<string, unknown>;
} {
  if (!isRec(doc)) {
    throw new Error('This does not look like an omg profile backup file.');
  }
  if (doc.schema !== 1) {
    throw new Error('This file is not a supported omg profile backup.');
  }
  const devices = doc.devices;
  if (!Array.isArray(devices) || devices.length === 0) {
    throw new Error('This does not look like an omg profile backup file.');
  }
  const dev = devices.find(
    (d) => isRec(d) && d.protocol === 'khub916',
  ) as Record<string, unknown> | undefined;
  if (!dev) throw new Error('This backup does not contain a khub916 keyboard.');

  const profiles = dev.profiles;
  const prof = (Array.isArray(profiles) ? profiles : []).find(
    (p) => isRec(p) && p.name === 'current',
  ) as Record<string, unknown> | undefined;
  const state = (prof?.state ??
    (Array.isArray(profiles) ? (profiles[0] as Record<string, unknown>)?.state : undefined)) as
    | Record<string, unknown>
    | undefined;
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    throw new Error('This backup has no keyboard settings to import.');
  }
  return { dev, state };
}

// ── Keymap ─────────────────────────────────────────────────────────────

interface KeymapJob {
  arg: number;
  values: number[];
}

/**
 * Split `state.keymap` into writable jobs vs. honest skips. Export wraps
 * each arg read in `sec()` — a failed read lands as `{"error": "…"}` and
 * an unused arg can be an empty array; neither is writable (cmd 3 needs
 * 1..=128 values), so those args are skipped by name instead of sinking
 * the whole section. Any OTHER malformed value rejects the section.
 */
function planKeymap(
  km: unknown,
  writer: ProfileImportWriter,
  skipped: string[],
): ImportSection | null {
  if (km === undefined || km === null) return null;
  if (!isRec(km)) {
    skipped.push('key assignments: unreadable data in the file');
    return null;
  }

  const writable: Record<number, unknown[]> = {};
  const bad: string[] = [];
  for (const [argStr, raw] of Object.entries(km)) {
    const arg = Number(argStr);
    if (!Number.isInteger(arg) || arg < 0 || arg > 7) {
      bad.push(`key set '${argStr}' is not an integer 0..7`);
      continue;
    }
    if (Array.isArray(raw)) {
      if (raw.length === 0) {
        skipped.push(`key set ${arg}: empty in the file — left unchanged`);
      } else {
        writable[arg] = raw;
      }
    } else if (isRec(raw) && typeof raw.error === 'string') {
      skipped.push(`key set ${arg}: not captured at export (${raw.error}) — left unchanged`);
    } else {
      bad.push(`key set ${argStr}: unreadable data`);
    }
  }
  if (bad.length) {
    skipped.push(`key assignments: ${bad[0]}${bad.length > 1 ? ` (+${bad.length - 1} more)` : ''}`);
    return null;
  }

  const jobs = Object.keys(writable)
    .map((k) => Number(k))
    .sort((a, b) => a - b)
    .map((arg) => ({ arg, values: writable[arg] ?? [] }));
  if (jobs.length === 0) return null;

  // Deep validation (u32 bounds, ≤128 entries) on the writable subset.
  const checked = validateKeymapSection(writable);
  if (!checked.ok || !checked.values) {
    skipped.push(`key assignments: ${checked.errors[0] ?? 'unreadable data'}`);
    return null;
  }

  if (!writer.writeKeymap) {
    skipped.push(`key assignments (${jobs.length} set(s)): ${PENDING}`);
    return null;
  }
  const writeKeymap = writer.writeKeymap;
  return {
    name: 'Key assignments',
    summary: `${jobs.length} key set(s)`,
    opType: 'keymap_write',
    snapSection: 'keymap',
    apply: async () => {
      const done: string[] = [];
      let verified = true;
      for (const j of jobs) {
        const values = checked.values![j.arg] ?? [];
        const out = await writeKeymap.call(writer, j.arg & 3, (j.arg >> 2) & 1, values);
        verified = verified && verifiedOf(out);
        done.push(`set ${(j.arg & 3) + 1}${verifiedOf(out) ? ' ✓' : ''}`);
      }
      return { text: `saved (${done.join(', ')})`, verified };
    },
  };
}

// ── Per-key colours (cmd 6) ────────────────────────────────────────────

function planLightColors(
  lc: unknown,
  liveColors: readonly Rgb[] | undefined,
  writer: ProfileImportWriter,
  skipped: string[],
): ImportSection | null {
  if (!Array.isArray(lc) || lc.length === 0) return null;
  const byIndex = new Map<number, Rgb>();
  let bad = lc.length > CUSTOM_LIGHT_SLOTS;
  if (!bad) {
    for (const e of lc) {
      const o = isRec(e) ? e : {};
      const i = o.index;
      const r = o.r;
      const g = o.g;
      const b = o.b;
      const idxOk =
        Number.isInteger(i) &&
        (i as number) >= 0 &&
        (i as number) < CUSTOM_LIGHT_SLOTS &&
        !byIndex.has(i as number);
      const rgbOk = [r, g, b].every(
        (v) => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 255,
      );
      if (!idxOk || !rgbOk) {
        bad = true;
        break;
      }
      byIndex.set(i as number, {
        r: (r as number) & 0xff,
        g: (g as number) & 0xff,
        b: (b as number) & 0xff,
      });
    }
  }
  // Fill gaps from the live snapshot so the 126-slot payload stays sane.
  const colors: Rgb[] = [];
  let complete = !bad;
  for (let i = 0; i < CUSTOM_LIGHT_SLOTS; i++) {
    const col = byIndex.get(i) ?? liveColors?.[i];
    if (!col) {
      complete = false;
      break;
    }
    colors.push({ r: col.r, g: col.g, b: col.b });
  }
  if (!complete) {
    skipped.push('per-key colours: unreadable data in the file');
    return null;
  }
  if (!writer.writeCustomLightColors) {
    skipped.push(`per-key colours (${byIndex.size} key(s)): ${PENDING}`);
    return null;
  }
  const writeColors = writer.writeCustomLightColors;
  return {
    name: 'Per-key colours',
    summary: `${byIndex.size} key colour(s) from the file`,
    opType: 'light_write',
    snapSection: 'lighting',
    apply: async () => {
      const out = await writeColors.call(writer, colors);
      return {
        text: verifiedOf(out) ? 'saved and checked' : 'saved',
        verified: verifiedOf(out),
      };
    },
  };
}

// ── Light-data blob (cmd 10) / macro region (cmd 5) ────────────────────

function planHexBlob(
  hex: unknown,
  maxBytes: number,
  what: string,
  writer: ProfileImportWriter,
  method: 'writeLightData' | 'writeMacroRegion',
  opType: OpType,
  snapSection: SnapshotSectionName,
  skipped: string[],
): ImportSection | null {
  if (typeof hex !== 'string' || hex.length === 0) return null;
  const bytes = hexToBytes(hex);
  if (!bytes || bytes.length === 0) {
    skipped.push(`${what}: unreadable data in the file`);
    return null;
  }
  if (bytes.length > maxBytes) {
    skipped.push(
      `${what}: ${bytes.length} bytes in the file — the wire blob holds at most ${maxBytes}`,
    );
    return null;
  }
  const write = writer[method];
  if (!write) {
    skipped.push(`${what} (${bytes.length} bytes of data): ${PENDING}`);
    return null;
  }
  const bound = write.bind(writer);
  return {
    name: what === 'lighting effects' ? 'Lighting effects' : 'Macros',
    summary: `${bytes.length} bytes of ${what === 'lighting effects' ? 'effect' : 'macro'} data`,
    opType,
    snapSection,
    apply: async () => {
      const out = await bound(bytes);
      return {
        text: verifiedOf(out) ? 'saved and checked' : 'saved',
        verified: verifiedOf(out),
      };
    },
  };
}

// ── Profile blob (cmd 4) — the bead-ra1 gap ────────────────────────────

interface ProfilePatchResult {
  blob: Uint8Array;
  /** Human-readable field list for the section summary. */
  fields: string[];
  /** Field-level problems that must land in `skipped`. */
  problems: string[];
}

/**
 * Build the cmd-4 profile payload for `state.profile`.
 *
 * Preferred: the file's own `hex` blob, verbatim — that is what the
 * device had at export, so every profile field (sleep, light mode and
 * the per-mode speed/brightness records) round-trips at once. Strict
 * guard: when the connected device's blob length is known, a different
 * length means the blob was made for different firmware — refuse rather
 * than write a mismatched layout.
 *
 * Fallback: no usable `hex` but `sleep_seconds`/`light_mode` are present
 * → patch the CURRENT device blob (`currentProfile`) field-by-field:
 * `profileWithSleepSeconds` for the u8 sleep field and
 * `decodeLightState`+`withLightMode` for the light mode (keeping the
 * device's current speed/brightness/colour-model). A field that cannot
 * be applied safely is reported, never guessed.
 */
function planProfileBlob(
  prof: Record<string, unknown>,
  currentProfile: Uint8Array | undefined,
  skipped: string[],
): { blob: Uint8Array; summary: string } | null {
  const hex = typeof prof.hex === 'string' && prof.hex.length > 0 ? prof.hex : undefined;
  const sleep = prof.sleep_seconds;
  const lmode = prof.light_mode;
  const sleepOk = Number.isInteger(sleep) && (sleep as number) >= 0 && (sleep as number) <= 255;
  const lmodeOk = Number.isInteger(lmode) && (lmode as number) >= 0 && (lmode as number) <= 0xffff;

  if (hex !== undefined) {
    const bytes = hexToBytes(hex);
    // Every hex problem is reported, then we FALL THROUGH to the
    // field-patch path — a corrupt/foreign blob must not sink the
    // sleep_seconds/light_mode fields the same file may carry.
    if (!bytes || bytes.length === 0) {
      skipped.push('device profile: unreadable hex in the file');
    } else if (bytes.length > PROFILE_HEX_MAX) {
      skipped.push(
        `device profile: ${bytes.length} bytes in the file — the wire blob holds at most ${PROFILE_HEX_MAX}`,
      );
    } else if (isInt(prof.bytes) && prof.bytes !== bytes.length) {
      skipped.push(
        `device profile: file says ${prof.bytes} bytes but the hex holds ${bytes.length} — inconsistent backup`,
      );
    } else if (currentProfile && currentProfile.length > 0 && bytes.length !== currentProfile.length) {
      skipped.push(
        `device profile: file blob is ${bytes.length} bytes but this keyboard's is ` +
          `${currentProfile.length} — different firmware layout, not applied verbatim`,
      );
    } else if (bytes.length < PROFILE_MIN_BYTES && (sleepOk || lmodeOk)) {
      // Blob too short to even hold the fields the file advertises.
      skipped.push(
        `device profile: ${bytes.length}-byte blob cannot carry sleep/light-mode fields — not applied verbatim`,
      );
    } else {
      const fields: string[] = [];
      if (sleepOk) fields.push(`sleep ${sleep} s`);
      if (lmodeOk) fields.push(`lighting mode ${lmode}`);
      return {
        blob: bytes,
        summary: fields.length
          ? `profile blob (${bytes.length} bytes; ${fields.join(', ')})`
          : `profile blob (${bytes.length} bytes)`,
      };
    }
  }

  // ── Field-patch path ──
  const wantsSleep = sleep !== undefined && sleep !== null;
  const wantsMode = lmode !== undefined && lmode !== null;
  if (!wantsSleep && !wantsMode) {
    skipped.push('device profile: no writable fields in the file');
    return null;
  }
  if (sleep !== undefined && sleep !== null && !sleepOk) {
    skipped.push(`device profile: sleep_seconds ${JSON.stringify(sleep)} is not 0..255`);
  }
  if (lmode !== undefined && lmode !== null && !lmodeOk) {
    skipped.push(`device profile: light_mode ${JSON.stringify(lmode)} is not 0..65535`);
  }
  if (!currentProfile || currentProfile.length < PROFILE_MIN_BYTES) {
    skipped.push(
      'device profile: only field values in the file and no readable device ' +
        'profile blob to patch — not applied',
    );
    return null;
  }

  const fields: string[] = [];
  const problems: string[] = [];
  let v: Uint8Array = currentProfile.slice();
  if (sleepOk) {
    try {
      v = profileWithSleepSeconds(v, sleep as number);
      fields.push(`sleep ${sleep} s`);
    } catch (e) {
      problems.push(
        `sleep_seconds: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  if (lmodeOk) {
    // Preserve the device's current per-mode speed/brightness/colour
    // model — the file only carries the mode id, not the whole record.
    const cur = decodeLightState(currentProfile);
    if (cur === null) {
      problems.push('light_mode: device profile blob cannot be decoded');
    } else {
      try {
        v = withLightMode(v, lmode as number, cur.speed, cur.brightness, cur.colorModel);
        fields.push(`lighting mode ${lmode}`);
      } catch (e) {
        problems.push(
          `light_mode: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
  }
  for (const p of problems) skipped.push(`device profile: ${p}`);
  if (fields.length === 0) return null;
  return { blob: v, summary: `profile fields (${fields.join(', ')})` };
}

function isInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v);
}

// ── Planner ────────────────────────────────────────────────────────────

/**
 * Parse a schema-v1 backup's khub916 `state` into writable sections.
 * Throws on document-shape errors (bad schema, no khub916 device, no
 * state) exactly like the old `parseProfileImport`; everything section-
 * level is reported via `sections`/`skipped`, never thrown.
 */
export function planProfileImport(
  doc: unknown,
  fileName: string,
  ctx: ProfileImportContext,
): ParsedImport {
  const { dev, state } = khub916StateOfDoc(doc);
  const w = ctx.writer;
  const sections: ImportSection[] = [];
  const skipped: string[] = [];

  // ── Compatibility gate (core/compatibility.ts — SAFETY-SPEC R1) ──
  //
  // Protocol mismatch blocks the import outright; a model mismatch is a
  // warning the user may override with an explicit confirm at apply time.
  const compatErrors = canApplyProfile(ctx.device, { protocol: 'khub916' }).reasons;
  const devInfo = isRec(state.device_info) ? state.device_info : undefined;
  const fileModel =
    typeof dev.model === 'string' && dev.model !== 'unknown' ? dev.model : undefined;
  const fileCatalog =
    devInfo && typeof devInfo.catalog_model === 'string' ? devInfo.catalog_model : undefined;
  const compatWarnings = canApplyProfile(ctx.device, {
    ...(fileModel ? { model: fileModel } : {}),
    ...(fileCatalog ? { catalogModel: fileCatalog } : {}),
  }).reasons;

  // ── Keymap (cmd 3 writes, args 0–7 = layer | system<<2) ──
  const kmSection = planKeymap(state.keymap, w, skipped);
  if (kmSection) sections.push(kmSection);

  // ── Custom light colours (cmd 6, needs all 126 slots) ──
  const lcSection = planLightColors(state.light_colors, ctx.liveColors, w, skipped);
  if (lcSection) sections.push(lcSection);

  // ── Per-mode light data (wired cmd 10) ──
  const ldSection = planHexBlob(
    state.light_data_hex,
    LIGHT_DATA_MAX,
    'lighting effects',
    w,
    'writeLightData',
    'light_write',
    'lighting',
    skipped,
  );
  if (ldSection) sections.push(ldSection);

  // ── Macro region (cmd 5) ──
  const mxSection = planHexBlob(
    state.macro_hex,
    MACRO_REGION_BYTES,
    'macros',
    w,
    'writeMacroRegion',
    'macro_write',
    'macro',
    skipped,
  );
  if (mxSection) sections.push(mxSection);

  // ── Profile blob / fields (cmd 4) ──
  const prof = state.profile;
  if (prof !== undefined && prof !== null) {
    if (!isRec(prof)) {
      skipped.push('device profile: unreadable data in the file');
    } else {
      const planned = planProfileBlob(prof, ctx.currentProfile, skipped);
      if (planned) {
        if (!w.writeProfile) {
          skipped.push(`device profile (${planned.summary}): ${PENDING}`);
        } else {
          const writeProfile = w.writeProfile.bind(w);
          const blob = planned.blob;
          sections.push({
            name: 'Device profile',
            summary: planned.summary,
            opType: 'settings_write',
            snapSection: 'profile',
            apply: async () => {
              const out = await writeProfile(blob);
              return {
                text: verifiedOf(out) ? 'saved and checked' : 'saved',
                verified: verifiedOf(out),
              };
            },
          });
        }
      }
    }
  }

  // ── Read-only export data — say so, never silently drop ──
  if (state.device_info !== undefined && state.device_info !== null) {
    skipped.push('device info: read-only identity data — nothing to write');
  }
  if (state.power !== undefined && state.power !== null) {
    skipped.push('battery level: read-only — not part of a restore');
  }

  return {
    fileName,
    model: String(dev.model ?? 'unknown'),
    sections,
    skipped,
    compatErrors,
    compatWarnings,
  };
}
