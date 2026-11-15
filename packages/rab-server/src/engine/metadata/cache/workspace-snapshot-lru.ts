import { compareVersions } from './metadata-snapshot';

/**
 * Metadata engine E5 — the in-process tier: one entry per (organisation, workspace), holding the NEWEST version this
 * process has seen. Entries are immutable (a version's content never changes), so nothing ever needs to be invalidated:
 * a lookup asks for an exact version (read from PostgreSQL by the caller) and anything else is a miss.
 *
 *  - `get(key, token)` hits only when the stored cache token (`<version>.<stamp>`) equals `token`.
 *  - `set(key, version, token, …)` never replaces a newer stored version with an older one (a long transaction still
 *    reading an old version just misses and falls through to Redis / PostgreSQL). The same version with another stamp (a
 *    reused version number after a restore) replaces the stored one: the caller only ever sets what PostgreSQL returned.
 *  - Bounded by entry count, total approximate bytes and a per-entry cap; idle entries expire (memory only — never a
 *    correctness input).
 *
 * Twenty keeps several hash-keyed versions per key with a 100 ms re-check against Redis
 * (twentyhq/twenty @ eedb0a73 `engine/workspace-cache/services/workspace-cache.service.ts:63-77, 541-561`); a version
 * read from PostgreSQL on every call makes that re-check unnecessary here.
 */
export interface SnapshotLruOptions {
  maxEntries: number;
  maxBytes: number;
  maxEntryBytes: number;
  idleTtlMs: number;
  now?: () => number;
}

export interface SnapshotLruStats {
  entries: number;
  approxBytes: number;
  evictions: number;
  expirations: number;
  setsRefusedOlder: number;
  setsRefusedTooLarge: number;
}

interface Entry<T> {
  version: string;
  token: string;
  value: T;
  bytes: number;
  lastReadAt: number;
}

export class WorkspaceSnapshotLru<T> {
  private readonly entries = new Map<string, Entry<T>>();
  private bytes = 0;
  private readonly now: () => number;
  private readonly counters = { evictions: 0, expirations: 0, setsRefusedOlder: 0, setsRefusedTooLarge: 0 };

  constructor(private readonly options: SnapshotLruOptions) {
    if (!(options.maxEntries >= 1) || !(options.maxBytes >= 1) || !(options.maxEntryBytes >= 1) || !(options.idleTtlMs >= 1)) {
      throw new Error('WorkspaceSnapshotLru: every limit must be positive.');
    }
    this.now = options.now ?? Date.now;
  }

  get(key: string, token: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    const now = this.now();
    if (now - entry.lastReadAt > this.options.idleTtlMs) {
      this.remove(key, entry);
      this.counters.expirations += 1;
      return undefined;
    }
    if (entry.token !== token) return undefined;
    entry.lastReadAt = now;
    // Map iteration order is insertion order: re-insert to mark most recently used.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  /** Returns false when refused (too large, the same token already stored, or a newer version stored). */
  set(key: string, version: string, token: string, value: T, bytes: number): boolean {
    if (bytes > this.options.maxEntryBytes) {
      this.counters.setsRefusedTooLarge += 1;
      return false;
    }
    const existing = this.entries.get(key);
    if (existing) {
      if (existing.token === token) return false;
      if (compareVersions(existing.version, version) > 0) {
        this.counters.setsRefusedOlder += 1;
        return false;
      }
      this.remove(key, existing);
    }
    this.entries.set(key, { version, token, value, bytes, lastReadAt: this.now() });
    this.bytes += bytes;
    this.evict();
    return true;
  }

  delete(key: string): void {
    const entry = this.entries.get(key);
    if (entry) this.remove(key, entry);
  }

  clear(): void {
    this.entries.clear();
    this.bytes = 0;
  }

  stats(): SnapshotLruStats {
    return { entries: this.entries.size, approxBytes: this.bytes, ...this.counters };
  }

  private remove(key: string, entry: Entry<T>): void {
    this.entries.delete(key);
    this.bytes -= entry.bytes;
  }

  private evict(): void {
    while (this.entries.size > this.options.maxEntries || this.bytes > this.options.maxBytes) {
      const oldest = this.entries.keys().next();
      if (oldest.done) return;
      this.remove(oldest.value, this.entries.get(oldest.value)!);
      this.counters.evictions += 1;
    }
  }
}
