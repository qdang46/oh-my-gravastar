/**
 * profile-history.ts — bead th0, PURE half: schema-v1 state extraction,
 * content hashing, per-section diff and the bounded localStorage history
 * store. No DOM, no device access, no imports beyond pure proto/safety
 * codecs — safe to unit-test under `node scripts/smoke.ts`.
 *
 * The schema-v1 `state` object is what `pages-secondary.ts::
 * buildProfileExport()` produces (keymap, light_colors, light_data_hex,
 * macro_hex, profile, power, device_info). Diff/restore reason over that
 * shape only; the write path lives in pages-secondary.ts/profiles.ts.
 */

import { hexToBytes } from './safety/validation.ts';
import { keyValueLabelOf } from './proto/khub916.ts';

function isRec(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// ── Schema-v1 state extraction + hashing ───────────────────────────────

/** The writable `state` object inside a schema-v1 profile doc. */
export type ProfileState = Record<string, unknown>;
export type ProfileDoc = Record<string, unknown>;

/**
 * Pull `devices[0].profiles[name=="current"].state` out of a schema-v1
 * doc — same selection rules as `parseProfileImport`. Returns null when
 * the doc doesn't carry a khub916 state.
 */
export function stateOfDoc(doc: unknown): ProfileState | null {
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
  if (!prof || !isRec(prof.state)) return null;
  return prof.state;
}

/**
 * FNV-1a hash of the JSON-serialised state — used to dedupe captures and
 * to find "the previous distinct state" for undo. Content-stable because
 * every doc comes from `buildProfileExport()` (fixed key order) or a
 * JSON round-trip of one.
 */
export function profileStateHash(state: unknown): string {
  const s = JSON.stringify(state ?? null);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

// ── Section model (shared by diff, restore picker and badges) ──────────

export type ProfileSectionId = 'keymap' | 'colours' | 'lighting' | 'macros' | 'profile';

export interface ProfileSectionDef {
  id: ProfileSectionId;
  /** state key inside the schema-v1 `state` object. */
  stateKey: string;
  /** Long title for diff/restore UI. */
  title: string;
  /** Short badge for history rows. */
  short: string;
}

export const PROFILE_SECTIONS: readonly ProfileSectionDef[] = [
  { id: 'keymap', stateKey: 'keymap', title: 'Key assignments', short: 'keys' },
  { id: 'colours', stateKey: 'light_colors', title: 'Per-key colours', short: 'colours' },
  { id: 'lighting', stateKey: 'light_data_hex', title: 'Lighting effects', short: 'light FX' },
  { id: 'macros', stateKey: 'macro_hex', title: 'Macros', short: 'macros' },
  { id: 'profile', stateKey: 'profile', title: 'Device profile (sleep/lighting mode)', short: 'profile' },
] as const;

/**
 * Sections `parseProfileImport` can actually write. `profile` is
 * export-only there (same stance as `omg profile import`), so it never
 * appears in the restore picker.
 */
export const RESTORABLE_SECTIONS: readonly ProfileSectionDef[] = PROFILE_SECTIONS.filter(
  (d) => d.id !== 'profile',
);

/** Sections present in a doc's state (for badges / picker defaults). */
export function sectionsInState(state: ProfileState | null): ProfileSectionDef[] {
  if (!state) return [];
  return PROFILE_SECTIONS.filter((d) => state[d.stateKey] !== undefined);
}

/** One-line summary of a section's payload, for pickers and confirms. */
export function sectionSummary(state: ProfileState | null, def: ProfileSectionDef): string {
  const v = state?.[def.stateKey];
  if (v === undefined || v === null) return 'not in this snapshot';
  if (def.id === 'keymap' && isRec(v)) {
    return `${Object.keys(v).length} key set(s)`;
  }
  if (def.id === 'colours' && Array.isArray(v)) {
    return `${v.length} colour(s)`;
  }
  if (def.id === 'profile' && isRec(v)) {
    return `sleep ${String(v.sleep_seconds ?? '?')} s · light mode ${String(v.light_mode ?? '?')}`;
  }
  const bytes = hexToBytes(typeof v === 'string' ? v : isRec(v) ? String(v.hex ?? '') : '');
  if (bytes && bytes.length > 0) return `${bytes.length} bytes`;
  return 'present';
}

// ── Diff engine ────────────────────────────────────────────────────────

export interface DiffLine {
  /** Where the change is, e.g. `set 1 · key 12`. */
  path: string;
  before: string;
  after: string;
  /** Optional extra context (e.g. first-difference offset for blobs). */
  note?: string;
}

export interface SectionDiff {
  id: ProfileSectionId;
  title: string;
  lines: DiffLine[];
}

/** Cap per section so a wholesale keymap rewrite can't flood the DOM. */
const MAX_DIFF_LINES = 400;

function pushCapped(lines: DiffLine[], line: DiffLine): void {
  if (lines.length < MAX_DIFF_LINES) {
    lines.push(line);
  } else if (lines.length === MAX_DIFF_LINES) {
    lines.push({ path: '…', before: 'more changes omitted', after: '' });
  }
}

/** u32 from a number or a `"0x........"` hex string (export format). */
function u32Of(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v >>> 0;
  if (typeof v === 'string') {
    const t = v.trim();
    const n = t.toLowerCase().startsWith('0x') ? Number.parseInt(t, 16) : Number(t);
    if (Number.isFinite(n)) return n >>> 0;
  }
  return null;
}

/** Human-readable key value: label + raw hex, matching the Keys page. */
function fmtKeyValue(v: unknown): string {
  if (v === undefined || v === null) return '—';
  const n = u32Of(v);
  if (n === null) return String(v);
  const hex = `0x${(n >>> 0).toString(16).toUpperCase().padStart(8, '0')}`;
  if (n === 0) return `unassigned (${hex})`;
  let label = '';
  try {
    label = keyValueLabelOf(n);
  } catch {
    label = '';
  }
  return label ? `${label} (${hex})` : hex;
}

function fmtColour(v: unknown): string {
  if (!isRec(v)) return '—';
  const r = u32Of(v.r);
  const g = u32Of(v.g);
  const b = u32Of(v.b);
  if (r === null || g === null || b === null) return '—';
  const h = (n: number) => n.toString(16).padStart(2, '0').toUpperCase();
  return `#${h(r)}${h(g)}${h(b)}`;
}

function bytesOf(v: unknown): Uint8Array | null {
  if (typeof v === 'string') return hexToBytes(v);
  if (isRec(v) && typeof v.hex === 'string') return hexToBytes(v.hex);
  return null;
}

function firstDiffIndex(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return i;
  }
  return a.length === b.length ? -1 : n;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

function diffKeymap(va: unknown, vb: unknown, lines: DiffLine[]): void {
  const a = isRec(va) ? va : {};
  const b = isRec(vb) ? vb : {};
  const args = [...new Set([...Object.keys(a), ...Object.keys(b)])]
    .map((k) => Number(k))
    .filter((n) => Number.isInteger(n))
    .sort((x, y) => x - y);
  for (const arg of args) {
    const ea = Array.isArray(a[String(arg)]) ? (a[String(arg)] as unknown[]) : [];
    const eb = Array.isArray(b[String(arg)]) ? (b[String(arg)] as unknown[]) : [];
    const n = Math.max(ea.length, eb.length);
    for (let i = 0; i < n; i++) {
      const fa = fmtKeyValue(ea[i]);
      const fb = fmtKeyValue(eb[i]);
      if (fa !== fb) {
        pushCapped(lines, {
          path: `key set ${arg} · position ${i + 1}`,
          before: fa,
          after: fb,
        });
      }
    }
  }
}

function diffColours(va: unknown, vb: unknown, lines: DiffLine[]): void {
  const toMap = (v: unknown): Map<number, string> => {
    const m = new Map<number, string>();
    if (Array.isArray(v)) {
      for (const e of v) {
        if (isRec(e) && typeof e.index === 'number') m.set(e.index, fmtColour(e));
      }
    }
    return m;
  };
  const a = toMap(va);
  const b = toMap(vb);
  const idx = [...new Set([...a.keys(), ...b.keys()])].sort((x, y) => x - y);
  for (const i of idx) {
    const fa = a.get(i) ?? '—';
    const fb = b.get(i) ?? '—';
    if (fa !== fb) {
      pushCapped(lines, { path: `colour ${i}`, before: fa, after: fb });
    }
  }
}

/** Single-line blob diff: byte counts + first-difference offset. */
function diffBlob(va: unknown, vb: unknown, path: string, lines: DiffLine[]): void {
  const ba = bytesOf(va);
  const bb = bytesOf(vb);
  if (ba === null || bb === null) {
    if (va !== vb) {
      pushCapped(lines, {
        path,
        before: typeof va === 'string' ? `${va.length} hex chars` : '—',
        after: typeof vb === 'string' ? `${vb.length} hex chars` : '—',
        note: 'unreadable hex — compared as text',
      });
    }
    return;
  }
  if (bytesEqual(ba, bb)) return;
  const diff = firstDiffIndex(ba, bb);
  pushCapped(lines, {
    path,
    before: `${ba.length} bytes`,
    after: `${bb.length} bytes`,
    note:
      diff >= 0
        ? `first difference at byte ${diff}`
        : ba.length !== bb.length
          ? 'length differs'
          : 'content differs',
  });
}

function diffProfileObj(va: unknown, vb: unknown, lines: DiffLine[]): void {
  const a = isRec(va) ? va : {};
  const b = isRec(vb) ? vb : {};
  for (const key of ['sleep_seconds', 'light_mode'] as const) {
    const fa = a[key] === undefined || a[key] === null ? '—' : String(a[key]);
    const fb = b[key] === undefined || b[key] === null ? '—' : String(b[key]);
    if (fa !== fb) {
      pushCapped(lines, {
        path: key === 'sleep_seconds' ? 'sleep timer (seconds)' : 'lighting mode',
        before: fa,
        after: fb,
      });
    }
  }
  diffBlob(a.hex, b.hex, 'profile blob', lines);
}

/**
 * Per-section diff between two schema-v1 `state` objects (null = empty
 * side). Returns one `SectionDiff` per section present on either side;
 * `lines` empty means the section is unchanged.
 */
export function diffProfileStates(
  a: ProfileState | null,
  b: ProfileState | null,
): SectionDiff[] {
  const out: SectionDiff[] = [];
  for (const def of PROFILE_SECTIONS) {
    const va = a?.[def.stateKey];
    const vb = b?.[def.stateKey];
    if (va === undefined && vb === undefined) continue;
    const lines: DiffLine[] = [];
    switch (def.id) {
      case 'keymap':
        diffKeymap(va, vb, lines);
        break;
      case 'colours':
        diffColours(va, vb, lines);
        break;
      case 'lighting':
      case 'macros':
        diffBlob(va, vb, def.title, lines);
        break;
      case 'profile':
        diffProfileObj(va, vb, lines);
        break;
    }
    out.push({ id: def.id, title: def.title, lines });
  }
  return out;
}

// ── History store (localStorage, bounded) ──────────────────────────────

export interface ProfileHistoryEntry {
  id: string;
  /** ISO-8601 capture time. */
  ts: string;
  /** Display name — `auto · <what>` for captures, user text for manual. */
  name: string;
  /** Content hash of the state (see profileStateHash). */
  hash: string;
  /** Full schema-v1 profile doc — restore re-validates before use. */
  doc: ProfileDoc;
}

export const PROFILE_HISTORY_MAX = 20;
export const PROFILE_HISTORY_KEY = 'omg.profiles.history.v1';

/** Minimal storage contract (localStorage in the app, memory in tests). */
export interface ProfileStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** In-memory storage for tests / non-DOM contexts. */
export function memoryProfileStorage(): ProfileStorage {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

function defaultStorage(): ProfileStorage {
  try {
    if (typeof localStorage !== 'undefined') return localStorage;
  } catch {
    // opaque origins can throw on access
  }
  return memoryProfileStorage();
}

function isEntry(v: unknown): v is ProfileHistoryEntry {
  return (
    isRec(v) &&
    typeof v.id === 'string' &&
    typeof v.ts === 'string' &&
    typeof v.name === 'string' &&
    typeof v.hash === 'string' &&
    isRec(v.doc)
  );
}

/**
 * Versioned profile snapshots, newest first. Entries are kept whole
 * (doc included) so diff/restore need no device access; the store is
 * bounded to `PROFILE_HISTORY_MAX`.
 */
export class ProfileHistory {
  private readonly storage: ProfileStorage;
  private entries: ProfileHistoryEntry[] | null = null;

  constructor(storage: ProfileStorage = defaultStorage()) {
    this.storage = storage;
  }

  private load(): ProfileHistoryEntry[] {
    if (this.entries) return this.entries;
    try {
      const raw = this.storage.getItem(PROFILE_HISTORY_KEY);
      const arr = raw ? (JSON.parse(raw) as unknown) : [];
      this.entries = Array.isArray(arr) ? arr.filter(isEntry) : [];
    } catch {
      this.entries = [];
    }
    return this.entries;
  }

  private persist(): void {
    this.storage.setItem(PROFILE_HISTORY_KEY, JSON.stringify(this.load()));
  }

  /** Newest-first entries (full docs — callers must not mutate them). */
  list(): readonly ProfileHistoryEntry[] {
    return this.load();
  }

  get(id: string): ProfileHistoryEntry | null {
    return this.load().find((e) => e.id === id) ?? null;
  }

  /** Prepend `entry`, enforce the bound, persist. */
  add(entry: ProfileHistoryEntry): void {
    const list = this.load();
    list.unshift(entry);
    if (list.length > PROFILE_HISTORY_MAX) list.length = PROFILE_HISTORY_MAX;
    this.persist();
  }

  remove(id: string): boolean {
    const list = this.load();
    const i = list.findIndex((e) => e.id === id);
    if (i < 0) return false;
    list.splice(i, 1);
    this.persist();
    return true;
  }

  clear(): void {
    this.load().length = 0;
    this.persist();
  }
}
