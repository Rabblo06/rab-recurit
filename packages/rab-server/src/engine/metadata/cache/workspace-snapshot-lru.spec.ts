import { WorkspaceSnapshotLru } from './workspace-snapshot-lru';

describe('WorkspaceSnapshotLru (metadata engine E5, in-process tier)', () => {
  let now = 0;
  const make = (over: Partial<ConstructorParameters<typeof WorkspaceSnapshotLru>[0]> = {}) =>
    new WorkspaceSnapshotLru<string>({ maxEntries: 3, maxBytes: 100, maxEntryBytes: 50, idleTtlMs: 1000, now: () => now, ...over });

  beforeEach(() => {
    now = 0;
  });

  it('hits only on the exact version', () => {
    const lru = make();
    lru.set('ws1', '2', '2.1', 'v2', 10);
    expect(lru.get('ws1', '2.1')).toBe('v2');
    expect(lru.get('ws1', '1.1')).toBeUndefined();
    expect(lru.get('ws1', '3.1')).toBeUndefined();
    expect(lru.get('ws2', '2.1')).toBeUndefined();
  });

  it('never replaces a newer version with an older one (numeric, not lexical, order)', () => {
    const lru = make();
    expect(lru.set('ws1', '10', '10.1', 'v10', 10)).toBe(true);
    expect(lru.set('ws1', '9', '9.1', 'v9', 10)).toBe(false);
    expect(lru.get('ws1', '10.1')).toBe('v10');
    expect(lru.set('ws1', '11', '11.1', 'v11', 10)).toBe(true);
    expect(lru.get('ws1', '10.1')).toBeUndefined();
    expect(lru.get('ws1', '11.1')).toBe('v11');
    expect(lru.stats()).toMatchObject({ entries: 1, approxBytes: 10, setsRefusedOlder: 1 });
  });

  it('the same version with another stamp (a reused version number) replaces the entry', () => {
    const lru = make();
    lru.set('ws1', '5', '5.100', 'old timeline', 10);
    expect(lru.set('ws1', '5', '5.200', 'restored + changed', 10)).toBe(true);
    expect(lru.get('ws1', '5.100')).toBeUndefined();
    expect(lru.get('ws1', '5.200')).toBe('restored + changed');
  });

  it('refuses an entry over the per-entry cap', () => {
    const lru = make();
    expect(lru.set('ws1', '1', '1.1', 'big', 51)).toBe(false);
    expect(lru.stats().setsRefusedTooLarge).toBe(1);
  });

  it('evicts least recently used by count and by bytes', () => {
    const lru = make();
    lru.set('a', '1', '1.1', 'a', 10);
    lru.set('b', '1', '1.1', 'b', 10);
    lru.set('c', '1', '1.1', 'c', 10);
    lru.get('a', '1.1'); // a becomes most recent
    lru.set('d', '1', '1.1', 'd', 10); // evicts b
    expect(lru.get('b', '1.1')).toBeUndefined();
    expect(lru.get('a', '1.1')).toBe('a');
    const bytes = make({ maxEntries: 10 });
    bytes.set('a', '1', '1.1', 'a', 40);
    bytes.set('b', '1', '1.1', 'b', 40);
    bytes.set('c', '1', '1.1', 'c', 40); // 120 > 100: a goes
    expect(bytes.get('a', '1.1')).toBeUndefined();
    expect(bytes.stats()).toMatchObject({ entries: 2, approxBytes: 80, evictions: 1 });
  });

  it('expires idle entries', () => {
    const lru = make();
    lru.set('a', '1', '1.1', 'a', 10);
    now = 1001;
    expect(lru.get('a', '1.1')).toBeUndefined();
    expect(lru.stats()).toMatchObject({ entries: 0, approxBytes: 0, expirations: 1 });
  });

  it('rejects non-positive limits', () => {
    expect(() => make({ maxEntries: 0 })).toThrow();
  });
});
