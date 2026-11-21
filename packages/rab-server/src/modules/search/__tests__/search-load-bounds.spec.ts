import { HttpStatus } from '@nestjs/common';
import { EntityManager, QueryFailedError } from 'typeorm';

import { bindBusinessSchema, unbindBusinessSchema } from '../../../engine/core-modules/tenant/business-tables';
import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { ResourceScope } from '../../../engine/core-modules/resource-scope/resource-scope.service';
import { TenantContextService } from '../../../engine/core-modules/tenant/tenant-context.service';
import { isStatementTimeout, SEARCH_TOO_BROAD, SearchTooBroadException } from '../exceptions/search.exceptions';
import { buildSearchQuery } from '../services/search-query';
import { OFFER_SEARCH_CANDIDATE_CAP, SearchService } from '../services/search.service';

/**
 * M9 load test §4.4 (PR #313, LOAD-TEST.md): a search term that matches every record
 *  1. ran into the search's own 5 s statement_timeout under load and surfaced as an unhandled 500 (the 11 manager-read
 *     errors of the final peak). A statement timeout is now a 422 SEARCH_TOO_BROAD; every other error is unchanged.
 *  2. joined and ranked every matching offer (119,581) to return 20. Each offer-search match branch now carries the SAME
 *     scope as the final query and stops after OFFER_SEARCH_CANDIDATE_CAP matches.
 */
const ctx = {
  organisationId: '11111111-1111-4111-8111-111111111111',
  workspaceId: '33333333-3333-4333-8333-333333333333',
  userId: '22222222-2222-4222-8222-222222222222',
  role: '',
} as AuthContext;

describe('search: a statement timeout is a 4xx, not a 500', () => {
  const serviceRejecting = (error: unknown) =>
    new SearchService({ runInTenantContext: jest.fn(async () => Promise.reject(error)) } as unknown as TenantContextService, {} as never, {} as never);

  it('isStatementTimeout: 57014 on a pg error or inside a QueryFailedError; nothing else', () => {
    expect(isStatementTimeout(Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' }))).toBe(true);
    expect(isStatementTimeout(new QueryFailedError('SELECT 1', [], Object.assign(new Error('canceling statement'), { code: '57014' })))).toBe(true);
    for (const other of [Object.assign(new Error('x'), { code: '42501' }), Object.assign(new Error('x'), { code: '40001' }), new Error('57014'), null, undefined, '57014']) {
      expect(isStatementTimeout(other)).toBe(false);
    }
  });

  it('a timed-out search answers 422 SEARCH_TOO_BROAD with a fixed message (never the term)', async () => {
    const timeout = Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' });
    const err = await serviceRejecting(timeout).search(ctx, { q: 'perf secret-term' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SearchTooBroadException);
    const http = err as SearchTooBroadException;
    expect(http.getStatus()).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
    expect(http.getResponse()).toEqual({ statusCode: 422, code: SEARCH_TOO_BROAD, message: 'That search matches too much. Type more of the name.' });
    expect(JSON.stringify(http.getResponse())).not.toContain('secret-term');
  });

  it('every other failure propagates unchanged (no blanket 4xx)', async () => {
    for (const other of [Object.assign(new Error('permission denied'), { code: '42501' }), new Error('pool timeout exceeded when trying to connect')]) {
      await expect(serviceRejecting(other).search(ctx, { q: 'perf' })).rejects.toBe(other);
    }
  });

  it('an empty query never opens a transaction', async () => {
    const runInTenantContext = jest.fn();
    const service = new SearchService({ runInTenantContext } as unknown as TenantContextService, {} as never, {} as never);
    await expect(service.search(ctx, { q: '   ' })).resolves.toEqual([]);
    expect(runInTenantContext).not.toHaveBeenCalled();
  });
});

describe('search: offer candidates are scoped and capped per match branch', () => {
  const bound: object[] = [];
  afterEach(() => {
    for (const m of bound.splice(0)) unbindBusinessSchema(m as never);
  });

  async function capture(scope: ResourceScope) {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const manager = {
      query: jest.fn(async (sql: string, params: unknown[]) => {
        calls.push({ sql, params });
        return [];
      }),
      queryRunner: { isReleased: false, isTransactionActive: true },
    };
    bindBusinessSchema(manager as never, 'core', null);
    bound.push(manager);
    const service = new SearchService({} as never, {} as never, {} as never);
    await (service as unknown as { searchOffers: (m: EntityManager, c: AuthContext, s: ResourceScope, q: ReturnType<typeof buildSearchQuery>, l: number) => Promise<unknown> })
      .searchOffers(manager as unknown as EntityManager, ctx, scope, buildSearchQuery('perf'), 8);
    expect(calls).toHaveLength(1);
    return calls[0]!;
  }

  const branches = (sql: string) => {
    const cand = sql.slice(sql.indexOf('WITH cand AS ('), sql.indexOf('SELECT o.id, v.name AS venue_name'));
    return cand.split(/\)\s*UNION\s*\(/);
  };
  const paramIndex = (sql: string, re: RegExp) => {
    const m = re.exec(sql);
    expect(m).not.toBeNull();
    return Number(m![1]);
  };

  it.each<[string, ResourceScope, RegExp]>([
    ['owner scope (offers the caller sent)', { kind: 'owner', ownerUserId: ctx.userId, delegated: false }, /o\.created_by = \$(\d+)/],
    ['venue scope (assigned venues)', { kind: 'venue', venueIds: ['44444444-4444-4444-8444-444444444444'] }, /s\.venue_id = ANY\(\$(\d+)::uuid\[\]\)/],
  ])('%s: both branches carry the organisation pin and the scope, and stop after the cap', async (_label, scope, scopeRe) => {
    const { sql, params } = await capture(scope);
    const parts = branches(sql);
    expect(parts).toHaveLength(2);
    const org = paramIndex(sql, /o\.organisation_id = \$(\d+)/);
    expect(params[org - 1]).toBe(ctx.organisationId);
    const scopeParam = paramIndex(sql, scopeRe);
    expect(params[scopeParam - 1]).toEqual(scope.kind === 'venue' ? scope.venueIds : ctx.userId);
    const cap = paramIndex(parts[0]!, /LIMIT \$(\d+)/);
    expect(params[cap - 1]).toBe(OFFER_SEARCH_CANDIDATE_CAP);
    for (const part of parts) {
      expect(part).toContain(`o.organisation_id = $${org} AND`);
      expect(part).toMatch(new RegExp(scopeRe.source.replace('(\\d+)', String(scopeParam))));
      expect(part).toContain(`LIMIT $${cap}`);
    }
    if (scope.kind === 'owner') for (const part of parts) expect(part).toContain(`o.workspace_id = $`);
    // The final query keeps its own scope and the caller's per-type limit (8).
    const final = sql.slice(sql.indexOf('SELECT o.id, v.name AS venue_name'));
    expect(final).toContain(`o.organisation_id = $${org} AND`);
    expect(params[paramIndex(final, /LIMIT \$(\d+)\s*$/) - 1]).toBe(8);
  });

  it('the cap is small enough to bound the work and large enough to rank a page', () => {
    expect(OFFER_SEARCH_CANDIDATE_CAP).toBeGreaterThanOrEqual(20 * 10);
    expect(OFFER_SEARCH_CANDIDATE_CAP).toBeLessThanOrEqual(1000);
  });
});
