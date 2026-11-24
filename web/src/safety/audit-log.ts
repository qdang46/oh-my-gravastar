/**
 * Append-only audit log — vision-full-custom.md §4 layer 5.
 *
 * A localStorage-backed ring buffer (~200 entries) recording every
 * classified operation and its outcome: `{ ts, op, class, result, detail }`.
 * The transaction executor and rollback write here so the UI can show an
 * honest activity log afterwards — including partial failures.
 */

import { memoryStorage, type KeyValueStorage } from './snapshots.ts';

export const AUDIT_KEY = 'omg.audit.log';
export const AUDIT_LIMIT = 200;

export interface AuditEntry {
  /** ISO-8601 timestamp. */
  ts: string;
  /** Operation type (policy OpType) or free-form label. */
  op: string;
  /** Policy class L0–L4 when the op went through `classify()`. */
  class?: string;
  /** Outcome: success | failed | unverified | denied | skipped | info. */
  result: string;
  /** Extra context (error message, section, snapshot id, …). */
  detail?: string;
}

function defaultStorage(): KeyValueStorage {
  try {
    if (typeof localStorage !== 'undefined') return localStorage;
  } catch {
    // opaque origins can throw on access
  }
  return memoryStorage();
}

export class AuditLog {
  private readonly storage: KeyValueStorage;
  private readonly key: string;

  constructor(storage: KeyValueStorage = defaultStorage(), key = AUDIT_KEY) {
    this.storage = storage;
    this.key = key;
  }

  /** Append one entry, evicting the oldest beyond AUDIT_LIMIT. */
  append(entry: Omit<AuditEntry, 'ts'> & { ts?: string }): AuditEntry {
    const full: AuditEntry = { ts: entry.ts ?? new Date().toISOString(), ...entry };
    const entries = this.list();
    entries.push(full);
    while (entries.length > AUDIT_LIMIT) entries.shift();
    this.storage.setItem(this.key, JSON.stringify(entries));
    return full;
  }

  /** Oldest → newest. */
  list(): AuditEntry[] {
    try {
      const raw = this.storage.getItem(this.key);
      if (!raw) return [];
      const v = JSON.parse(raw) as unknown;
      if (!Array.isArray(v)) return [];
      return v.filter(
        (e): e is AuditEntry =>
          typeof e === 'object' &&
          e !== null &&
          typeof (e as AuditEntry).ts === 'string' &&
          typeof (e as AuditEntry).op === 'string' &&
          typeof (e as AuditEntry).result === 'string',
      );
    } catch {
      return [];
    }
  }

  /** Newest `n` entries, newest first. */
  tail(n = 20): AuditEntry[] {
    return this.list().slice(-n).reverse();
  }

  clear(): void {
    this.storage.removeItem(this.key);
  }
}
