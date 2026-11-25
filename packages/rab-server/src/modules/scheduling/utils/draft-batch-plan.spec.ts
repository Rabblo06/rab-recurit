import { DraftCandidate, TargetCheck, localDate, moveByLocalDays, planDrafts, slotKey, targetKey, weekCopyWindows } from './draft-batch-plan';

const LONDON = 'Europe/London';

const candidate = (key: string, startsAt: string, endsAt: string, over: Partial<DraftCandidate> = {}): DraftCandidate => ({
  key,
  venueId: 'v1',
  jobRoleId: 'r1',
  startsAt: new Date(startsAt),
  endsAt: new Date(endsAt),
  breakMinutes: 30,
  requiredCount: 2,
  chargeRatePence: 0,
  notes: null,
  address: null,
  ...over,
});

describe('weekCopyWindows', () => {
  it('source is the 7 local days before weekStart and target the 7 from it (organisation midnight, not UTC)', () => {
    const { source, target } = weekCopyWindows('2026-07-13', LONDON);
    expect(source.from.toISOString()).toBe('2026-07-05T23:00:00.000Z'); // BST: local midnight is 23:00 UTC
    expect(source.to.toISOString()).toBe('2026-07-12T23:00:00.000Z');
    expect(target.from).toEqual(source.to);
    expect(target.to.toISOString()).toBe('2026-07-19T23:00:00.000Z');
  });
});

describe('moveByLocalDays', () => {
  it('keeps the wall-clock start and the exact duration across the spring clock change', () => {
    // Sat 21 March 2026 09:00 GMT → Sat 28 March 2026 09:00 GMT (clocks go forward on Sun 29 March).
    const moved = moveByLocalDays(new Date('2026-03-21T09:00:00Z'), new Date('2026-03-21T17:00:00Z'), 7, LONDON);
    expect(moved.startsAt.toISOString()).toBe('2026-03-28T09:00:00.000Z');
    // Mon 23 March 09:00 GMT → Mon 30 March 09:00 BST = 08:00 UTC; still 8 hours long.
    const after = moveByLocalDays(new Date('2026-03-23T09:00:00Z'), new Date('2026-03-23T17:00:00Z'), 7, LONDON);
    expect(after.startsAt.toISOString()).toBe('2026-03-30T08:00:00.000Z');
    expect(after.endsAt.getTime() - after.startsAt.getTime()).toBe(8 * 3_600_000);
    expect(localDate(after.startsAt, LONDON)).toBe('2026-03-30');
  });

  it('keeps an overnight shift overnight (same duration, start moved by a week)', () => {
    const moved = moveByLocalDays(new Date('2026-06-05T21:00:00Z'), new Date('2026-06-06T05:00:00Z'), 7, LONDON);
    expect(moved).toEqual({ startsAt: new Date('2026-06-12T21:00:00Z'), endsAt: new Date('2026-06-13T05:00:00Z') });
  });
});

describe('planDrafts', () => {
  const now = new Date('2026-07-01T00:00:00Z');
  const ok = new Map<string, TargetCheck>([[targetKey('v1', 'r1'), null]]);

  it('creates a future shift whose venue and job role are usable', () => {
    const [row] = planDrafts([candidate('a', '2026-07-14T09:00:00Z', '2026-07-14T17:00:00Z')], { existingSlots: new Set(), targetChecks: ok, now });
    expect(row).toMatchObject({ key: 'a', outcome: 'create' });
    expect(row!.reason).toBeUndefined();
  });

  it('skips with a reason: past, existing identical shift, duplicate in batch, unusable target, not selected', () => {
    const existing = slotKey('v1', 'r1', new Date('2026-07-15T09:00:00Z'), new Date('2026-07-15T17:00:00Z'));
    const checks = new Map<string, TargetCheck>([
      [targetKey('v1', 'r1'), null],
      [targetKey('v2', 'r1'), 'venue_archived'],
      [targetKey('v1', 'r2'), 'job_role_unavailable'],
    ]);
    const rows = planDrafts(
      [
        candidate('past', '2026-06-30T09:00:00Z', '2026-06-30T17:00:00Z'),
        candidate('exists', '2026-07-15T09:00:00Z', '2026-07-15T17:00:00Z'),
        candidate('first', '2026-07-16T09:00:00Z', '2026-07-16T17:00:00Z'),
        candidate('second', '2026-07-16T09:00:00Z', '2026-07-16T17:00:00Z'),
        candidate('archivedVenue', '2026-07-17T09:00:00Z', '2026-07-17T17:00:00Z', { venueId: 'v2' }),
        candidate('foreignRole', '2026-07-17T09:00:00Z', '2026-07-17T17:00:00Z', { jobRoleId: 'r2' }),
        candidate('unchecked', '2026-07-17T09:00:00Z', '2026-07-17T17:00:00Z', { venueId: 'v9' }),
      ],
      { existingSlots: new Set([existing]), targetChecks: checks, now },
    );
    expect(rows.map((r) => [r.key, r.outcome, r.reason])).toEqual([
      ['past', 'skip', 'starts_in_past'],
      ['exists', 'skip', 'already_exists'],
      ['first', 'create', undefined],
      ['second', 'skip', 'duplicate_in_batch'],
      ['archivedVenue', 'skip', 'venue_archived'],
      ['foreignRole', 'skip', 'job_role_unavailable'],
      ['unchecked', 'skip', 'venue_unavailable'], // fail closed: a target nobody checked is never created
    ]);
  });

  it('confirm with a selection creates only the selected rows', () => {
    const rows = planDrafts(
      [candidate('keep', '2026-07-14T09:00:00Z', '2026-07-14T17:00:00Z'), candidate('drop', '2026-07-15T09:00:00Z', '2026-07-15T17:00:00Z')],
      { existingSlots: new Set(), targetChecks: ok, now, selectedKeys: new Set(['keep']) },
    );
    expect(rows.map((r) => [r.key, r.outcome, r.reason])).toEqual([
      ['keep', 'create', undefined],
      ['drop', 'skip', 'not_selected'],
    ]);
  });
});
