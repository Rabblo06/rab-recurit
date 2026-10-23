/**
 * Wave 5 lane OPS — the in-process L1 store behind `MetadataL1CacheService`.
 *
 * A plain bounded LRU with a per-entry TTL, an entry cap AND an approximate byte cap, plus an invalidation fence:
 *
 *  - `ticket(key)` is taken BEFORE a caller starts the slow L2/Postgres read;
 *  - `set(ticket, value)` is refused when the key (or its group, or the whole cache) was invalidated after that ticket
 *    was issued.
 *
 * That fence closes the classic fill-after-invalidate race: a reader that started before an invalidation can never put
 * its now-stale value into L1 after the invalidation landed. It is the same argument as the Redis epoch keys in
 * `CoreEntityCacheService`, applied to process memory.
 *
 * No timers: expiry is checked on read, and on write when the cache is over capacity. Nothing here is security- or
 * authorisation-relevant by construction — the only caller restricts which kinds may enter (see
 * `L1_CACHEABLE_KINDS`).
 */
export interface LruStats {
  entries: number;
  approxBytes: number;
  hits: number;
  misses: number;
  sets: number;
  setsRefusedStale: number;
  setsRefusedTooLarge: number;
  evictions: number;
  expirations: number;
  invalidations: number;
  clears: number;
}

export interface LruTicket {
  readonly key: string;
  readonly group: string;
  readonly seq: number;
}

interface Entry<T> {
  value: T;
  expiresAt: number;
  bytes: number;
  group: string;
}

/** How long an invalidation marker is remembered — far longer than any fill could take (DB statement timeout is 30 s). */
const FENCE_MEMORY_MS = 120_000;

export class BoundedLruCache<T = unknown> {
  private readonly entries = new Map<string, Entry<T>>();
  /** key -> seq of its last invalidation (with the wall-clock time, for pruning). */
  private readonly keyFence = new Map<string, { seq: number; at: number }>();
  /** group -> seq of its last group-wide invalidation. */
  private readonly groupFence = new Map<string, number>();
  private clearSeq = 0;
  private seq = 0;
  private bytes = 0;
  private readonly counters: Omit<LruStats, 'entries' | 'approxBytes'> = {
    hits: 0,
    misses: 0,
    sets: 0,
    setsRefusedStale: 0,
    setsRefusedTooLarge: 0,
    evictions: 0,
    expirations: 0,
    invalidations: 0,
    clears: 0,
  };

  constructor(
    private readonly options: {
      maxEntries: number;
      maxBytes: number;
      maxEntryBytes: number;
      now?: () => number;
    },
  ) {
    if (!(options.maxEntries >= 1) || !(options.maxBytes >= 1) || !(options.maxEntryBytes >= 1)) {
      throw new Error('BoundedLruCache: maxEntries, maxBytes and maxEntryBytes must be positive.');
    }
  }

  private now(): number {
    return this.options.now ? this.options.now() : Date.now();
  }

  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) {
      this.counters.misses += 1;
      return undefined;
    }
    if (entry.expiresAt <= this.now()) {
      this.remove(key, entry);
      this.counters.expirations += 1;
      this.counters.misses += 1;
      return undefined;
    }
    // LRU touch: re-insert so Map iteration order (oldest first) tracks recency.
    this.entries.delete(key);
    this.entries.set(key, entry);
    this.counters.hits += 1;
    return entry.value;
  }

  ticket(key: string, group: string): LruTicket {
    return { key, group, seq: this.seq };
  }

  /** Stores `value` unless the ticket is stale (an invalidation landed after it was issued). Returns whether it stored. */
  set(ticket: LruTicket, value: T, ttlMs: number): boolean {
    const keyFence = this.keyFence.get(ticket.key)?.seq ?? -1;
    const groupFence = this.groupFence.get(ticket.group) ?? -1;
    if (this.clearSeq > ticket.seq || keyFence > ticket.seq || groupFence > ticket.seq) {
      this.counters.setsRefusedStale += 1;
      return false;
    }
    if (!(ttlMs > 0)) return false;
    const bytes = approximateBytes(ticket.key, value);
    if (bytes > this.options.maxEntryBytes) {
      this.counters.setsRefusedTooLarge += 1;
      return false;
    }
    const existing = this.entries.get(ticket.key);
    if (existing) this.remove(ticket.key, existing);
    this.entries.set(ticket.key, { value, expiresAt: this.now() + ttlMs, bytes, group: ticket.group });
    this.bytes += bytes;
    this.counters.sets += 1;
    this.enforceCapacity();
    return true;
  }

  invalidate(key: string): void {
    this.seq += 1;
    this.keyFence.set(key, { seq: this.seq, at: this.now() });
    const entry = this.entries.get(key);
    if (entry) this.remove(key, entry);
    this.counters.invalidations += 1;
    this.pruneFences();
  }

  /** Drops every entry of `group` and fences every in-flight fill for it. */
  invalidateGroup(group: string): void {
    this.seq += 1;
    this.groupFence.set(group, this.seq);
    for (const [key, entry] of this.entries) {
      if (entry.group === group) this.remove(key, entry);
    }
    this.counters.invalidations += 1;
  }

  clear(): void {
    this.seq += 1;
    this.clearSeq = this.seq;
    this.entries.clear();
    this.bytes = 0;
    this.counters.clears += 1;
  }

  stats(): LruStats {
    return { entries: this.entries.size, approxBytes: this.bytes, ...this.counters };
  }

  private remove(key: string, entry: Entry<T>): void {
    this.entries.delete(key);
    this.bytes -= entry.bytes;
  }

  private enforceCapacity(): void {
    if (this.entries.size <= this.options.maxEntries && this.bytes <= this.options.maxBytes) return;
    const now = this.now();
    // First drop anything already expired, then the least recently used.
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) {
        this.remove(key, entry);
        this.counters.expirations += 1;
      }
    }
    for (const [key, entry] of this.entries) {
      if (this.entries.size <= this.options.maxEntries && this.bytes <= this.options.maxBytes) break;
      this.remove(key, entry);
      this.counters.evictions += 1;
    }
  }

  private pruneFences(): void {
    if (this.keyFence.size < 10_000) return;
    const cutoff = this.now() - FENCE_MEMORY_MS;
    for (const [key, fence] of this.keyFence) {
      if (fence.at < cutoff) this.keyFence.delete(key);
    }
    // Still too many recent fences (an invalidation storm): fall back to a full clear, which fences everything at once.
    if (this.keyFence.size >= 10_000) {
      this.keyFence.clear();
      this.clear();
    }
  }
}

/** UTF-16 length of the key + JSON-serialised value, doubled (V8 string cost). An estimate, used only for the cap. */
function approximateBytes(key: string, value: unknown): number {
  let json: string;
  try {
    json = JSON.stringify(value) ?? '';
  } catch {
    return Number.MAX_SAFE_INTEGER; // unserialisable: never cached
  }
  return (key.length + json.length) * 2 + 64;
}
