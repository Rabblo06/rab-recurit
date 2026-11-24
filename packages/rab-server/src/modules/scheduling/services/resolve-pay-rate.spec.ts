import { EntityManager } from 'typeorm';

import { JobRole } from '../entities/job-role.entity';
import { VenueRoleRate } from '../entities/venue-role-rate.entity';
import { assertPayRateSet, organisationLocalDate, PAY_RATE_REQUIRED_CODE, PAY_RATE_REQUIRED_MESSAGE, PayRateRequiredException } from '../utils/pay-rate-rules';
import { SchedulingService } from './scheduling.service';

/**
 * `SchedulingService.resolvePayRate`: the shift-level rate resolution (architecture §1 A6), under the owner's decided rules:
 *   1. an explicit `payRatePence` (a manager-typed rate) wins and reads nothing;
 *   2. the venue role rate in force on the shift start's ORGANISATION-LOCAL date (decision 40: both ends inclusive,
 *      core.organisation.timezone), latest effective_from wins;
 *   3. the job role's default rate;
 *   4. decision 39: a result of £0 — at any level, an explicit 0 included — is refused (409 PAY_RATE_REQUIRED, "Set a pay
 *      rate for this role first."), never a £0 shift.
 * The staff role rate is applied per seat (send / confirmation), never to the shift (PR #311).
 *
 * The queries are executed by PostgreSQL, so this spec records the query the method builds (scope, the organisation-local
 * date, ordering) and feeds back the rows the database would return. The real-database behaviour — inclusive end date,
 * organisation time zone, a rate change never repricing an existing shift or a confirmed seat, the £0 refusal on every
 * create / publish path — is in resolve-pay-rate.integration.spec.ts.
 */
interface RecordedQuery {
  entity: unknown;
  alias: string;
  where: Array<{ sql: string; params?: Record<string, unknown> }>;
  orderBy: Array<[string, string]>;
}

function fakeManager(opts: { venueRate?: Partial<VenueRoleRate> | null; jobRole?: Partial<JobRole> | null; localDay?: string }) {
  const queries: RecordedQuery[] = [];
  const findOne = jest.fn(async (entity: unknown) => (entity === JobRole ? (opts.jobRole ?? null) : null));
  const query = jest.fn(async (_sql: string, _params: unknown[]) => [{ day: opts.localDay ?? '2026-12-05' }]);
  const createQueryBuilder = jest.fn((entity: unknown, alias: string) => {
    const q: RecordedQuery = { entity, alias, where: [], orderBy: [] };
    queries.push(q);
    const qb = {
      where: (sql: string, params?: Record<string, unknown>) => (q.where.push({ sql, params }), qb),
      andWhere: (sql: string, params?: Record<string, unknown>) => (q.where.push({ sql, params }), qb),
      orderBy: (column: string, direction: string) => (q.orderBy.push([column, direction]), qb),
      getOne: async () => opts.venueRate ?? null,
    };
    return qb;
  });
  return { manager: { findOne, createQueryBuilder, query } as unknown as EntityManager, queries, findOne, createQueryBuilder, query };
}

// resolvePayRate uses only the manager it is given; none of the constructor's collaborators.
const service = Object.create(SchedulingService.prototype) as SchedulingService;
const params = { venueId: 'venue-1', jobRoleId: 'role-1', startsAt: '2026-12-05T18:00:00.000Z' };

describe('SchedulingService.resolvePayRate', () => {
  it('level 1: an explicit rate wins over everything and reads nothing', async () => {
    const fake = fakeManager({ venueRate: { payRatePence: 2000 }, jobRole: { defaultRatePence: 1400 } });
    await expect(service.resolvePayRate(fake.manager, { ...params, payRatePence: 1777 })).resolves.toBe(1777);
    expect(fake.createQueryBuilder).not.toHaveBeenCalled();
    expect(fake.findOne).not.toHaveBeenCalled();
    expect(fake.query).not.toHaveBeenCalled();
  });

  it('decision 39: an explicit 0 is refused too (never a £0 shift)', async () => {
    await expect(service.resolvePayRate(fakeManager({}).manager, { ...params, payRatePence: 0 })).rejects.toBeInstanceOf(PayRateRequiredException);
  });

  it('level 2: the venue role rate in force on the organisation-local date wins over the job role default (decision 40)', async () => {
    const fake = fakeManager({ venueRate: { payRatePence: 2000 }, jobRole: { defaultRatePence: 1400 }, localDay: '2026-12-06' });
    await expect(service.resolvePayRate(fake.manager, params)).resolves.toBe(2000);
    expect(fake.findOne).not.toHaveBeenCalled(); // the default is never read once a venue rate applies
    // The organisation-local date is computed by PostgreSQL from the start instant (bound, never interpolated).
    const [sql, bound] = fake.query.mock.calls[0]!;
    expect(sql).toContain('AT TIME ZONE coalesce((SELECT o.timezone FROM core.organisation o WHERE o.id = core.current_org())');
    expect(bound).toEqual([params.startsAt]);
    const [q] = fake.queries;
    expect(q!.entity).toBe(VenueRoleRate);
    expect(q!.where).toEqual([
      { sql: 'r.venue_id = :venueId', params: { venueId: 'venue-1' } },
      { sql: 'r.job_role_id = :jobRoleId', params: { jobRoleId: 'role-1' } },
      // Both ends inclusive, compared as dates: a rate ending on day D applies to a shift starting any time on D.
      { sql: 'r.effective_from <= CAST(:day AS date)', params: { day: '2026-12-06' } },
      { sql: '(r.effective_to IS NULL OR r.effective_to >= CAST(:day AS date))', params: { day: '2026-12-06' } },
    ]);
    // Several rates in force (overlapping history): the most recently effective one wins.
    expect(q!.orderBy).toEqual([['r.effective_from', 'DESC']]);
  });

  it('level 3: no venue role rate → the job role default', async () => {
    const fake = fakeManager({ venueRate: null, jobRole: { defaultRatePence: 1400 } });
    await expect(service.resolvePayRate(fake.manager, params)).resolves.toBe(1400);
    expect(fake.findOne).toHaveBeenCalledWith(JobRole, { where: { id: 'role-1' } });
  });

  it('level 4 (decision 39): no venue rate and no default (or a 0 default / 0 venue rate) → refused, never 0', async () => {
    for (const opts of [
      { venueRate: null, jobRole: { defaultRatePence: 0 } },
      { venueRate: null, jobRole: { defaultRatePence: undefined } },
      { venueRate: null, jobRole: null },
      { venueRate: { payRatePence: 0 }, jobRole: { defaultRatePence: 1400 } },
    ]) {
      await expect(service.resolvePayRate(fakeManager(opts).manager, params)).rejects.toMatchObject({
        status: 409,
        response: { code: PAY_RATE_REQUIRED_CODE, message: PAY_RATE_REQUIRED_MESSAGE },
      });
    }
  });

  it('the result is a whole number of pence taken as stored (no float arithmetic, no rounding)', async () => {
    const fake = fakeManager({ venueRate: { payRatePence: 1234 } });
    const rate = await service.resolvePayRate(fake.manager, params);
    expect(Number.isInteger(rate)).toBe(true);
    expect(rate).toBe(1234);
  });
});

describe('pay rate rules (decisions 39 and 40)', () => {
  it('assertPayRateSet accepts a positive whole number of pence only', () => {
    expect(assertPayRateSet(1)).toBe(1);
    for (const bad of [0, -1, 1.5, Number.NaN, null, undefined, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => assertPayRateSet(bad as number)).toThrow(PayRateRequiredException);
    }
    expect(PAY_RATE_REQUIRED_MESSAGE).toBe('Set a pay rate for this role first.');
  });

  it('organisationLocalDate binds the instant as UTC ISO and refuses an invalid one', async () => {
    const query = jest.fn(async (..._args: unknown[]) => [{ day: '2026-12-06' }]);
    await expect(organisationLocalDate({ query } as unknown as EntityManager, new Date('2026-12-05T23:30:00.000Z'))).resolves.toBe('2026-12-06');
    expect(query.mock.calls[0]![1]).toEqual(['2026-12-05T23:30:00.000Z']);
    await expect(organisationLocalDate({ query } as unknown as EntityManager, 'nope')).rejects.toThrow('invalid instant');
  });
});
