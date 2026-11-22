import { EntityManager } from 'typeorm';

import { JobRole } from '../entities/job-role.entity';
import { VenueRoleRate } from '../entities/venue-role-rate.entity';
import { SchedulingService } from './scheduling.service';

/**
 * `SchedulingService.resolvePayRate`: the shift-level rate resolution (architecture §1 A6). Today's precedence, every
 * level pinned here:
 *   1. an explicit `payRatePence` (a manager-typed rate) wins, even 0, and reads nothing;
 *   2. the venue role rate in force at the shift start (venue + job role, effective_from <= start, effective_to null
 *      or >= start, latest effective_from wins);
 *   3. the job role's default rate;
 *   4. 0 when the job role has no default (or is not found).
 * The staff role rate step of A6 does not exist yet (no per-staff rate table) — see the PR / report.
 *
 * The query is executed by PostgreSQL, so this spec records the query the method builds (scope, effective-date
 * filter, ordering) and feeds back the row the database would return. The real-database behaviour, including "a rate
 * change never reprices an existing shift or a confirmed seat", is in resolve-pay-rate.integration.spec.ts.
 */
interface RecordedQuery {
  entity: unknown;
  alias: string;
  where: Array<{ sql: string; params?: Record<string, unknown> }>;
  orderBy: Array<[string, string]>;
}

function fakeManager(opts: { venueRate?: Partial<VenueRoleRate> | null; jobRole?: Partial<JobRole> | null }) {
  const queries: RecordedQuery[] = [];
  const findOne = jest.fn(async (entity: unknown) => (entity === JobRole ? (opts.jobRole ?? null) : null));
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
  return { manager: { findOne, createQueryBuilder } as unknown as EntityManager, queries, findOne, createQueryBuilder };
}

// resolvePayRate uses only the manager it is given; none of the constructor's collaborators.
const service = Object.create(SchedulingService.prototype) as SchedulingService;
const params = { venueId: 'venue-1', jobRoleId: 'role-1', startsAt: '2026-12-05T18:00:00.000Z' };

describe('SchedulingService.resolvePayRate', () => {
  it('level 1: an explicit rate wins over everything and reads nothing (an explicit 0 included)', async () => {
    const fake = fakeManager({ venueRate: { payRatePence: 2000 }, jobRole: { defaultRatePence: 1400 } });
    await expect(service.resolvePayRate(fake.manager, { ...params, payRatePence: 1777 })).resolves.toBe(1777);
    await expect(service.resolvePayRate(fake.manager, { ...params, payRatePence: 0 })).resolves.toBe(0);
    expect(fake.createQueryBuilder).not.toHaveBeenCalled();
    expect(fake.findOne).not.toHaveBeenCalled();
  });

  it('level 2: the venue role rate in force at the shift start wins over the job role default', async () => {
    const fake = fakeManager({ venueRate: { payRatePence: 2000 }, jobRole: { defaultRatePence: 1400 } });
    await expect(service.resolvePayRate(fake.manager, params)).resolves.toBe(2000);
    expect(fake.findOne).not.toHaveBeenCalled(); // the default is never read once a venue rate applies
    const [q] = fake.queries;
    expect(q!.entity).toBe(VenueRoleRate);
    expect(q!.where).toEqual([
      { sql: 'r.venue_id = :venueId', params: { venueId: 'venue-1' } },
      { sql: 'r.job_role_id = :jobRoleId', params: { jobRoleId: 'role-1' } },
      { sql: 'r.effective_from <= :start', params: { start: params.startsAt } },
      { sql: '(r.effective_to IS NULL OR r.effective_to >= :start)', params: { start: params.startsAt } },
    ]);
    // Several rates in force (overlapping history): the most recently effective one wins.
    expect(q!.orderBy).toEqual([['r.effective_from', 'DESC']]);
  });

  it('level 3: no venue role rate → the job role default', async () => {
    const fake = fakeManager({ venueRate: null, jobRole: { defaultRatePence: 1400 } });
    await expect(service.resolvePayRate(fake.manager, params)).resolves.toBe(1400);
    expect(fake.findOne).toHaveBeenCalledWith(JobRole, { where: { id: 'role-1' } });
  });

  it('level 4: no venue rate and no default → 0 (FLAGGED: resolves to 0 pence rather than refusing)', async () => {
    await expect(service.resolvePayRate(fakeManager({ venueRate: null, jobRole: { defaultRatePence: undefined } }).manager, params)).resolves.toBe(0);
    await expect(service.resolvePayRate(fakeManager({ venueRate: null, jobRole: null }).manager, params)).resolves.toBe(0);
  });

  it('the result is a whole number of pence taken as stored (no float arithmetic, no rounding)', async () => {
    const fake = fakeManager({ venueRate: { payRatePence: 1234 } });
    const rate = await service.resolvePayRate(fake.manager, params);
    expect(Number.isInteger(rate)).toBe(true);
    expect(rate).toBe(1234);
  });
});
