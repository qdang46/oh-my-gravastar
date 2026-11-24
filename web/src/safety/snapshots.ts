/**
 * Pre-write snapshots — vision-full-custom.md §4 layer 5 (recovery) and
 * §4.2 risk "multi-section restore partial failure → journal + rollback".
 *
 * `SnapshotStore` keeps restore points in Web Storage under the
 * `omg.snap.` prefix. A snapshot captures every writable section the
 * khub916 session can read — keymap layers (args 0–7), the per-mode
 * lighting blob + 126 custom colours, the macro region and the profile
 * blob — hex-encoded so the JSON stays storage-safe.
 *
 * Reads go through the small `SnapshotSource` interface, which
 * `Khub916Session` satisfies structurally (`profile()` returns
 * `ProfileInfo` — we keep `.raw`). Writes are *not* here; see
 * rollback.ts, which restores sections through the session's write
 * methods.
 */

import { hexToBytes, toHex } from './validation.ts';

export const SNAPSHOT_PREFIX = 'omg.snap.';
const INDEX_KEY = `${SNAPSHOT_PREFIX}index`;

/** Minimal storage contract (localStorage in the app, memory in tests). */
export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** In-memory storage for tests / non-DOM contexts. */
export function memoryStorage(): KeyValueStorage {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

function defaultStorage(): KeyValueStorage {
  try {
    if (typeof localStorage !== 'undefined') return localStorage;
  } catch {
    // access can throw in opaque origins
  }
  return memoryStorage();
}

// ── Snapshot shape ─────────────────────────────────────────────────────

/** Keymap args captured per snapshot (layer | system<<2, args 0–7). */
export const SNAPSHOT_KEYMAP_ARGS = 8;

export interface SnapshotRgb {
  r: number;
  g: number;
  b: number;
}

export interface SnapshotSections {
  /** arg ("0".."7") → u32 key values. */
  keymap?: Record<string, number[]>;
  /** Per-mode light blob (hex) + custom 126-slot colours. */
  lighting?: {
    lightData?: string;
    colors?: SnapshotRgb[];
  };
  /** Macro region (hex, ≤512 bytes decoded). */
  macro?: string;
  /** Profile/config blob (hex). */
  profile?: string;
}

export type SnapshotSectionName = 'keymap' | 'lighting' | 'macro' | 'profile';

export interface DeviceSnapshot {
  id: string;
  label: string;
  /** ISO-8601 capture time. */
  ts: string;
  sections: SnapshotSections;
  /** Section → read error, when a capture read failed (snapshot is partial). */
  errors?: Partial<Record<SnapshotSectionName, string>>;
}

export interface SnapshotMeta {
  id: string;
  label: string;
  ts: string;
  /** Sections successfully captured. */
  sections: SnapshotSectionName[];
  /** True when at least one section read failed during capture. */
  partial: boolean;
}

/**
 * Read side of a khub916 session — satisfied structurally by
 * `Khub916Session` (see hid.ts). All reads are sequential; concurrent
 * feature reports poison the session on this firmware.
 */
export interface SnapshotSource {
  keyValues(arg: number): Promise<number[]>;
  lightColorData(): Promise<Uint8Array>;
  customLightColors(): Promise<readonly SnapshotRgb[]>;
  profile(): Promise<{ raw: Uint8Array }>;
  macroRegion(): Promise<Uint8Array>;
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ── Store ──────────────────────────────────────────────────────────────

export class SnapshotStore {
  private readonly storage: KeyValueStorage;
  private readonly prefix: string;

  constructor(storage: KeyValueStorage = defaultStorage(), prefix = SNAPSHOT_PREFIX) {
    this.storage = storage;
    this.prefix = prefix;
  }

  private snapKey(id: string): string {
    return `${this.prefix}${id}`;
  }

  private readIndex(): string[] {
    try {
      const raw = this.storage.getItem(INDEX_KEY);
      const arr = raw ? (JSON.parse(raw) as unknown) : [];
      return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : [];
    } catch {
      return [];
    }
  }

  private writeIndex(ids: string[]): void {
    this.storage.setItem(INDEX_KEY, JSON.stringify(ids));
  }

  /**
   * Capture all writable sections from `source` and store them under a
   * fresh id. Section reads run sequentially; a failed section is
   * recorded in `snapshot.errors` and simply omitted — the snapshot is
   * marked `partial` rather than aborting the whole capture.
   */
  async capture(source: SnapshotSource, label: string): Promise<DeviceSnapshot> {
    const sections: SnapshotSections = {};
    const errors: Partial<Record<SnapshotSectionName, string>> = {};
    const failed = (name: SnapshotSectionName, e: unknown): void => {
      errors[name] = msg(e);
    };

    // Keymap layers — args 0..7, like `khub916_state` in profile.rs.
    try {
      const keymap: Record<string, number[]> = {};
      for (let arg = 0; arg < SNAPSHOT_KEYMAP_ARGS; arg++) {
        keymap[String(arg)] = await source.keyValues(arg);
      }
      sections.keymap = keymap;
    } catch (e) {
      failed('keymap', e);
    }

    try {
      const lightData = await source.lightColorData();
      const colors = await source.customLightColors();
      sections.lighting = {
        lightData: toHex(lightData),
        colors: colors.map((c) => ({ r: c.r & 0xff, g: c.g & 0xff, b: c.b & 0xff })),
      };
    } catch (e) {
      failed('lighting', e);
    }

    try {
      sections.macro = toHex(await source.macroRegion());
    } catch (e) {
      failed('macro', e);
    }

    try {
      sections.profile = toHex((await source.profile()).raw);
    } catch (e) {
      failed('profile', e);
    }

    const snap: DeviceSnapshot = {
      id: `snap-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      label,
      ts: new Date().toISOString(),
      sections,
      ...(Object.keys(errors).length > 0 ? { errors } : {}),
    };
    this.storage.setItem(this.snapKey(snap.id), JSON.stringify(snap));
    const ids = this.readIndex();
    ids.unshift(snap.id);
    this.writeIndex(ids);
    return snap;
  }

  /** Newest-first snapshot metadata (no section payloads). */
  list(): SnapshotMeta[] {
    const out: SnapshotMeta[] = [];
    for (const id of this.readIndex()) {
      const snap = this.get(id);
      if (!snap) continue; // dangling index entry — skip
      out.push({
        id: snap.id,
        label: snap.label,
        ts: snap.ts,
        sections: (Object.keys(snap.sections) as SnapshotSectionName[]).filter(
          (s) => snap.sections[s] !== undefined,
        ),
        partial: snap.errors !== undefined && Object.keys(snap.errors).length > 0,
      });
    }
    return out;
  }

  get(id: string): DeviceSnapshot | null {
    try {
      const raw = this.storage.getItem(this.snapKey(id));
      if (!raw) return null;
      const v = JSON.parse(raw) as DeviceSnapshot;
      if (typeof v !== 'object' || v === null || typeof v.id !== 'string') return null;
      return v;
    } catch {
      return null;
    }
  }

  remove(id: string): boolean {
    const had = this.storage.getItem(this.snapKey(id)) !== null;
    this.storage.removeItem(this.snapKey(id));
    this.writeIndex(this.readIndex().filter((x) => x !== id));
    return had;
  }

  /**
   * Drop snapshots older than `maxAgeMs` and/or beyond `maxCount`
   * (newest kept). Returns the number removed.
   */
  prune(opts: { maxAgeMs?: number; maxCount?: number } = {}): number {
    const ids = this.readIndex();
    const now = Date.now();
    const keep = new Set<string>();
    let removed = 0;
    let count = 0;
    for (const id of ids) {
      const snap = this.get(id);
      const ts = snap ? Date.parse(snap.ts) : NaN;
      const tooOld = opts.maxAgeMs !== undefined && (!Number.isFinite(ts) || now - ts > opts.maxAgeMs);
      const tooMany = opts.maxCount !== undefined && count >= opts.maxCount;
      if (snap === null || tooOld || tooMany) {
        this.storage.removeItem(this.snapKey(id));
        removed++;
      } else {
        keep.add(id);
        count++;
      }
    }
    this.writeIndex(ids.filter((id) => keep.has(id)));
    return removed;
  }
}

/**
 * Auto-snapshot helper for write paths: capture the device state *before*
 * a mutation so a later `restoreSnapshot` can undo it. Returns the stored
 * snapshot (check `.errors` — a partial snapshot still restores what it
 * captured).
 */
export async function snapshotBeforeWrite(
  store: SnapshotStore,
  source: SnapshotSource,
  label: string,
): Promise<DeviceSnapshot> {
  return store.capture(source, label);
}

/** Decode a stored hex section back to bytes (null on bad data). */
export function snapshotBytes(hex: string | undefined): Uint8Array | null {
  if (hex === undefined) return null;
  return hexToBytes(hex);
}
