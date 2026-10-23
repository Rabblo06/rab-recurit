import { BoundedLruCache } from './bounded-lru-cache';

describe('BoundedLruCache (wave 5 lane OPS L1 store)', () => {
  let now = 1_000_000;
  const clock = () => now;
  const make = (over: Partial<{ maxEntries: number; maxBytes: number; maxEntryBytes: number }> = {}) =>
    new BoundedLruCache<unknown>({ maxEntries: 3, maxBytes: 1_000_000, maxEntryBytes: 10_000, now: clock, ...over });

  beforeEach(() => {
    now = 1_000_000;
  });

  it('serves a value until its TTL, then misses (expiry counted)', () => {
    const c = make();
    expect(c.set(c.ticket('a', 'g'), { v: 1 }, 2000)).toBe(true);
    expect(c.get('a')).toEqual({ v: 1 });
    now += 1999;
    expect(c.get('a')).toEqual({ v: 1 });
    now += 1;
    expect(c.get('a')).toBeUndefined();
    expect(c.stats()).toMatchObject({ hits: 2, misses: 1, expirations: 1, entries: 0 });
  });

  it('evicts the least recently USED entry beyond maxEntries', () => {
    const c = make();
    for (const k of ['a', 'b', 'c']) c.set(c.ticket(k, 'g'), k, 10_000);
    c.get('a'); // touch a: b is now the oldest
    c.set(c.ticket('d', 'g'), 'd', 10_000);
    expect(c.get('b')).toBeUndefined();
    expect(c.get('a')).toBe('a');
    expect(c.get('d')).toBe('d');
    expect(c.stats().evictions).toBe(1);
    expect(c.stats().entries).toBe(3);
  });

  it('enforces the approximate byte cap and refuses oversized entries', () => {
    const c = make({ maxEntries: 1000, maxBytes: 2_000, maxEntryBytes: 1_500 });
    expect(c.set(c.ticket('big', 'g'), 'x'.repeat(2_000), 10_000)).toBe(false);
    expect(c.stats().setsRefusedTooLarge).toBe(1);
    for (let i = 0; i < 20; i++) c.set(c.ticket(`k${i}`, 'g'), 'y'.repeat(200), 10_000);
    expect(c.stats().approxBytes).toBeLessThanOrEqual(2_000);
    expect(c.stats().evictions).toBeGreaterThan(0);
  });

  it('fences a fill that started BEFORE an invalidation (no stale value re-enters)', () => {
    const c = make();
    const ticket = c.ticket('ws-1', 'workspace_schema_resolution'); // reader starts its slow read
    c.invalidate('ws-1'); // the write commits and invalidates meanwhile
    expect(c.set(ticket, 'stale', 10_000)).toBe(false);
    expect(c.get('ws-1')).toBeUndefined();
    expect(c.stats().setsRefusedStale).toBe(1);
    // A fill that starts after the invalidation is accepted.
    expect(c.set(c.ticket('ws-1', 'workspace_schema_resolution'), 'fresh', 10_000)).toBe(true);
    expect(c.get('ws-1')).toBe('fresh');
  });

  it('a group invalidation drops every entry of that group and fences its in-flight fills only', () => {
    const c = make({ maxEntries: 10 });
    c.set(c.ticket('l1', 'workspace_host_label'), 1, 10_000);
    c.set(c.ticket('l2', 'workspace_host_label'), 2, 10_000);
    c.set(c.ticket('s1', 'workspace_schema_resolution'), 3, 10_000);
    const inflightLabel = c.ticket('l3', 'workspace_host_label');
    const inflightSchema = c.ticket('s2', 'workspace_schema_resolution');
    c.invalidateGroup('workspace_host_label');
    expect(c.get('l1')).toBeUndefined();
    expect(c.get('l2')).toBeUndefined();
    expect(c.get('s1')).toBe(3);
    expect(c.set(inflightLabel, 'stale', 10_000)).toBe(false);
    expect(c.set(inflightSchema, 'ok', 10_000)).toBe(true);
  });

  it('clear() fences every in-flight fill', () => {
    const c = make();
    const t = c.ticket('a', 'g');
    c.clear();
    expect(c.set(t, 'x', 10_000)).toBe(false);
    expect(c.stats().clears).toBe(1);
  });

  it('refuses an unserialisable value instead of caching it', () => {
    const c = make();
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(c.set(c.ticket('c', 'g'), circular, 10_000)).toBe(false);
  });
});
