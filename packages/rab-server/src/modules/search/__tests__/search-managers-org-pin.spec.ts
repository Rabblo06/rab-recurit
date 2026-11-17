import { EntityManager } from 'typeorm';

import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { buildSearchQuery } from '../services/search-query';
import { SearchService } from '../services/search.service';

/**
 * SF-6: `searchManagers` carries its own organisation predicate (layer 3), not only manager_profile's RLS (layer 4). The
 * integration suite cannot tell the two apart (RLS already hides another organisation's managers), so this pins the
 * application-layer predicate itself: the statement filters `mp.organisation_id` on a bound parameter that is exactly the
 * caller's verified organisation, never a client value.
 */
describe('SearchService.searchManagers organisation pin (SF-6)', () => {
  const ctx = { organisationId: '11111111-1111-4111-8111-111111111111', workspaceId: null, userId: '22222222-2222-4222-8222-222222222222', role: '' } as AuthContext;

  async function capture(q: string) {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const manager = { query: jest.fn(async (sql: string, params: unknown[]) => { calls.push({ sql, params }); return []; }) } as unknown as EntityManager;
    const service = new SearchService({} as never, {} as never, {} as never);
    await (service as unknown as { searchManagers: (m: EntityManager, c: AuthContext, query: ReturnType<typeof buildSearchQuery>, limit: number) => Promise<unknown> })
      .searchManagers(manager, ctx, buildSearchQuery(q), 8);
    expect(calls).toHaveLength(1);
    return calls[0]!;
  }

  it.each([['a name query', 'peer'], ['an email-like query', 'peer@example']])('%s: WHERE mp.organisation_id = $n, with $n = the caller\'s organisation', async (_label, q) => {
    const { sql, params } = await capture(q);
    const match = /mp\.organisation_id = \$(\d+)/.exec(sql);
    expect(match).not.toBeNull();
    expect(params[Number(match![1]) - 1]).toBe(ctx.organisationId);
    // It is part of the WHERE clause (ANDed with the match), not a select-list column.
    expect(sql.slice(sql.indexOf('WHERE'))).toContain(`mp.organisation_id = $${match![1]} AND`);
  });
});
