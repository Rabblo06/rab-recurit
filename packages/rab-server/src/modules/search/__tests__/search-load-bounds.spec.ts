import { HttpStatus } from '@nestjs/common';
import { EntityManager, QueryFailedError } from 'typeorm';

import { bindBusinessSchema, unbindBusinessSchema } from '../../../engine/core-modules/tenant/business-tables';
import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { ResourceScope } from '../../../engine/core-modules/resource-scope/resource-scope.service';
import { TenantContextService } from '../../../engine/core-modules/tenant/tenant-context.service';
import { isStatementTimeout, SEARCH_TOO_BROAD, SearchTooBroadException, searchTooBroadCount } from '../exceptions/search.exceptions';
import { buildSearchQuery } from '../services/search-query';
import { OFFER_SEARCH_CANDIDATE_CAP, SearchService } from '../services/search.service';

/**
 * M9 load test §4.4 (PR #313, LOAD-TEST.md): a search term that matches every record
 *  1. ran into the search's own 5 s statement_timeout under load and surfaced as an unhandled 500 (the 11 manager-read
 *     errors of the final peak). A genuine statement timeout in a search statement is now a 422 SEARCH_TOO_BROAD;
 *     a user-request cancel, a timeout in the permission / scope lookups and every other error are unchanged.
 *  2. joined and ranked every matching offer (119,581) to return 20. Each offer-search match branch now carries the SAME
 *     scope as the final query and stops after OFFER_SEARCH_CANDIDATE_CAP matches.
 */
const ctx = {
  organisationId: '11111111-1111-4111-8111-111111111111',
  workspaceId: '33333333-3333-4333-8333-333333333333',
  userId: '22222222-2222-4222-8222-222222222222',
  role: '',
} as AuthContext;

const pgError = (code: string, message: string) => Object.assign(new Error(message), { code });
const STATEMENT_TIMEOUT = 'canceling statement due to statement timeout';
const USER_CANCEL = 'canceling statement due to user request';

describe('search: a genuine statement timeout in the search statements is a 4xx, nothing else is', () => {
  const bound: object[] = [];
  afterEach(() => {
    for (const m of bound.splice(0)) unbindBusinessSchema(m as never);
  });

  /**
   * A real search() run: the transaction callback runs on a fake manager. `failAt` picks where the error is raised: in a
   * search statement (the first per-type query) or in the permission lookup that runs before any search statement.
   */
  function service(error: unknown, failAt: 'search' | 'permission') {
    const manager = {
      query: jest.fn(async (sql: string) => {
        if (sql.startsWith(`SELECT set_config('jit'`)) return [];
        throw error;
      }),
      queryRunner: { isReleased: false, isTransactionActive: true },
    };
    bindBusinessSchema(manager as never, 'core', null);
    bound.push(manager);
    const tenantContext = { runInTenantContext: jest.fn(async (_c: AuthContext, fn: (m: EntityManager) => Promise<unknown>) => fn(manager as unknown as EntityManager)) };
    const permissions = {
      userHasPermissionTx: jest.fn(async () => {
        if (failAt === 'permission') throw error;
        return true;
      }),
    };
    const resourceScope = { resolveTx: jest.fn(async () => ({ kind: 'owner', ownerUserId: ctx.userId, delegated: false })) };
    const svc = new SearchService(tenantContext as unknown as TenantContextService, resourceScope as never, permissions as never);
    (svc as unknown as { memberAccess: unknown }).memberAccess = {
      resolveTx: jest.fn(async () => ({ canRead: true, restricted: false })),
      isFieldVisible: () => true,
      rawWhere: () => ({ sql: 'true', positional: [] }),
    };
    return svc;
  }

  it('isStatementTimeout: 57014 WITH the statement-timeout message (pg error or QueryFailedError); nothing else', () => {
    expect(isStatementTimeout(pgError('57014', STATEMENT_TIMEOUT))).toBe(true);
    expect(isStatementTimeout(new QueryFailedError('SELECT 1', [], pgError('57014', STATEMENT_TIMEOUT)))).toBe(true);
    for (const other of [
      pgError('57014', USER_CANCEL), // an administrator's pg_cancel_backend
      new QueryFailedError('SELECT 1', [], pgError('57014', USER_CANCEL)),
      pgError('57014', 'canceling statement'),
      pgError('42501', STATEMENT_TIMEOUT),
      pgError('40001', 'x'),
      new Error(STATEMENT_TIMEOUT),
      null,
      undefined,
      '57014',
    ]) {
      expect(isStatementTimeout(other)).toBe(false);
    }
  });

  it('a timed-out search statement answers 422 SEARCH_TOO_BROAD with a fixed message (never the term), counted', async () => {
    const before = searchTooBroadCount();
    const err = await service(pgError('57014', STATEMENT_TIMEOUT), 'search').search(ctx, { q: 'perf secret-term' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SearchTooBroadException);
    const http = err as SearchTooBroadException;
    expect(http.getStatus()).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
    expect(http.getResponse()).toEqual({ statusCode: 422, code: SEARCH_TOO_BROAD, message: 'That search matches too much. Type more of the name.' });
    expect(JSON.stringify(http.getResponse())).not.toContain('secret-term');
    expect(searchTooBroadCount()).toBe(before + 1);
  });

  it("57014 'canceling statement due to user request' (pg_cancel_backend) in a search statement stays a server error", async () => {
    const cancel = pgError('57014', USER_CANCEL);
    const before = searchTooBroadCount();
    await expect(service(cancel, 'search').search(ctx, { q: 'perf' })).rejects.toBe(cancel);
    expect(searchTooBroadCount()).toBe(before);
  });

  it('a statement timeout in the permission / scope lookups (before any search statement) stays a server error', async () => {
    const timeout = pgError('57014', STATEMENT_TIMEOUT);
    await expect(service(timeout, 'permission').search(ctx, { q: 'perf' })).rejects.toBe(timeout);
  });

  it('every other failure propagates unchanged (no blanket 4xx)', async () => {
    for (const other of [pgError('42501', 'permission denied'), new Error('pool timeout exceeded when trying to connect')]) {
      await expect(service(other, 'search').search(ctx, { q: 'perf' })).rejects.toBe(other);
    }
  });

  it('an empty query never opens a transaction', async () => {
    const runInTenantContext = jest.fn();
    const svc = new SearchService({ runInTenantContext } as unknown as TenantContextService, {} as never, {} as never);
    await expect(svc.search(ctx, { q: '   ' })).resolves.toEqual([]);
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
