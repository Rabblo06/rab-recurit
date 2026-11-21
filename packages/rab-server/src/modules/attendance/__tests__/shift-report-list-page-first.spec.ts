import { EntityManager } from 'typeorm';

import { bindBusinessSchema, unbindBusinessSchema } from '../../../engine/core-modules/tenant/business-tables';
import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { ResourceScope } from '../../../engine/core-modules/resource-scope/resource-scope.service';
import { REPORT_IN_HISTORY_SQL, REPORT_NEEDS_ATTENTION_SQL } from '../services/report-lifecycle';
import { ShiftReportService } from '../services/shift-report.service';

/**
 * M9 load test §4.4 (LOAD-TEST.md Q2 / Q3 / Q10; 41 % of database time at the 2x spike): the report lists page the shifts
 * BEFORE aggregating staff and attendance. Pinned here on the statement itself (the bucket boundaries and scoping are
 * covered against real rows by venue-manager-scoping / sf2-layer2-venue-reports integration suites):
 *  - the scope, the status exclusion, the bucket predicate, the order and LIMIT / OFFSET all run before any read of
 *    shift_assignment or attendance;
 *  - the window total is computed in the paged step, over the bucket-filtered rows (before LIMIT, as before);
 *  - the counts are aggregated per page row and the final rows keep the page order.
 */
const ctx = {
  organisationId: '11111111-1111-4111-8111-111111111111',
  workspaceId: '33333333-3333-4333-8333-333333333333',
  userId: '22222222-2222-4222-8222-222222222222',
  role: '',
} as AuthContext;

describe('ShiftReportService.listReports: page first, aggregate the page (M9 §4.4)', () => {
  const bound: object[] = [];
  afterEach(() => {
    for (const m of bound.splice(0)) unbindBusinessSchema(m as never);
  });

  async function capture(scope: ResourceScope, bucket: 'current' | 'history', page = 2, limit = 25) {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const manager = {
      query: jest.fn(async (sql: string, params: unknown[]) => {
        calls.push({ sql, params });
        return sql.includes('now() AS n') ? [{ n: new Date('2026-11-21T12:00:00Z') }] : [];
      }),
      queryRunner: { isReleased: false, isTransactionActive: true },
    };
    bindBusinessSchema(manager as never, 'core', null);
    bound.push(manager);
    const tenantContext = { runInWorkspaceContext: jest.fn(async (_c: AuthContext, fn: (m: EntityManager) => Promise<unknown>) => fn(manager as unknown as EntityManager)) };
    const permissions = { assertPermissionTx: jest.fn(async () => undefined) };
    const resourceScope = { resolveTx: jest.fn(async () => scope) };
    const service = new ShiftReportService(tenantContext as never, resourceScope as never, {} as never, {} as never, permissions as never, {} as never);
    const out = await service.listReports(ctx, { bucket, page, limit } as never);
    expect(out).toMatchObject({ data: [], total: 0 });
    expect(permissions.assertPermissionTx).toHaveBeenCalledTimes(1);
    return calls[0]!;
  }

  it.each<[string, ResourceScope, 'current' | 'history', string, string]>([
    ['manager, current', { kind: 'owner', ownerUserId: ctx.userId, delegated: false }, 'current', 's.created_by = $2', `(NOT ${REPORT_IN_HISTORY_SQL} OR ${REPORT_NEEDS_ATTENTION_SQL})`],
    ['venue manager, history', { kind: 'venue', venueIds: ['44444444-4444-4444-8444-444444444444'] }, 'history', 's.venue_id = ANY($2::uuid[])', REPORT_IN_HISTORY_SQL],
  ])('%s: scope, bucket, order and LIMIT / OFFSET come before any assignment / attendance read', async (_label, scope, bucket, scopeSql, bucketSql) => {
    const { sql, params } = await capture(scope, bucket);
    expect(params).toEqual([ctx.organisationId, scope.kind === 'venue' ? scope.venueIds : ctx.userId, 25, 25]);

    const pageEnd = sql.indexOf('LIMIT $3 OFFSET $4');
    expect(pageEnd).toBeGreaterThan(0);
    const before = sql.slice(0, pageEnd);
    const after = sql.slice(pageEnd);
    expect(before).toContain(`WHERE s.organisation_id = $1 AND ${scopeSql}`);
    expect(before).toContain(`AND s.status NOT IN ('draft','pending_manager_approval','declined')`);
    expect(before).toContain(`WHERE ${bucketSql}`);
    expect(before).toContain('count(*) OVER () AS total');
    expect(before).not.toMatch(/shift_assignment|attendance/);
    expect(after).toContain('"core"."shift_assignment" sa');
    expect(after).toContain('"core"."attendance" a');
    expect(after).toContain('WHERE sa.shift_id = r.shift_id');

    const order = bucket === 'history' ? 'r.ends_at DESC, r.shift_id' : `${REPORT_NEEDS_ATTENTION_SQL} DESC, r.starts_at ASC, r.shift_id`;
    // Ordered twice: to pick the page, and again for the final rows (a join may reorder them).
    expect(sql.split(`ORDER BY ${order}`)).toHaveLength(3);
    expect(sql.trimEnd().endsWith(`ORDER BY ${order}`)).toBe(true);
  });
});
