import { WorkspaceRoutingError } from '@rab/server/engine/core-modules/tenant/schema-resolver.service';

import { discoverMembersInWorkspaces, WalkMember } from './workspace-discovery';

/**
 * Phase D-Q4a: the shared walk of the combined shift scan. Same primitives as discoverInWorkspaces (catalogue pages in a
 * READ ONLY transaction, one READ ONLY worker tenant transaction per workspace), plus one SAVEPOINT per member so a
 * member's failing query never fails the other members. Real PostgreSQL savepoint behaviour is proven in
 * dq4-shift-scan-equivalence.integration.spec.ts.
 */
const ORG_A = '00000000-0000-4000-8000-00000000000a';
const ORG_B = '00000000-0000-4000-8000-00000000000b';
const ws = (n: number) => `00000000-0000-4000-8000-0000000001${String(n).padStart(2, '0')}`;

function harness(pages: Array<Array<{ workspace_id: string; organisation_id: string }>>, opts: { contextError?: (workspaceId: string) => unknown; pageError?: unknown } = {}) {
  const statements: string[] = [];
  const contexts: unknown[] = [];
  const options: unknown[] = [];
  let pageIndex = 0;
  const pageParams: unknown[][] = [];
  const catalogue = {
    query: async (sql: string, params?: unknown[]) => {
      statements.push(`catalogue: ${sql.trim().split(/\s+/).slice(0, 3).join(' ')}`);
      if (sql.includes('worker_list_workspaces')) {
        if (opts.pageError) throw opts.pageError;
        pageParams.push(params!);
        return pages[pageIndex++] ?? [];
      }
      return [];
    },
  };
  const runtime = { transaction: async <T>(fn: (m: unknown) => Promise<T>) => fn(catalogue) };
  const tenant = {
    runInTenantContext: async <T>(ctx: { workspaceId: string }, fn: (m: unknown) => Promise<T>, txOptions?: unknown) => {
      contexts.push(ctx);
      options.push(txOptions);
      const err = opts.contextError?.(ctx.workspaceId);
      if (err) throw err;
      const manager = { workspaceId: ctx.workspaceId, query: async (sql: string) => void statements.push(`${ctx.workspaceId.slice(-2)}: ${sql}`) };
      return fn(manager);
    },
  };
  return { statements, contexts, options, pageParams, run: (members: WalkMember[]) => discoverMembersInWorkspaces(runtime as never, tenant as never, members) };
}

const member = (key: string, behaviour: (workspaceId: string) => unknown[] | Error): WalkMember => ({
  key,
  discover: async (manager) => {
    const wsId = (manager as unknown as { workspaceId: string }).workspaceId;
    await manager.query(`${key} discovery`);
    const out = behaviour(wsId);
    if (out instanceof Error) throw out;
    return out;
  },
});

describe('discoverMembersInWorkspaces (D-Q4a shared walk)', () => {
  it('one READ ONLY worker transaction per workspace runs every member, each inside its own SAVEPOINT', async () => {
    const h = harness([[{ workspace_id: ws(1), organisation_id: ORG_A }, { workspace_id: ws(2), organisation_id: ORG_B }]]);
    const result = await h.run([member('a', (w) => [`a@${w.slice(-2)}`]), member('b', (w) => [`b@${w.slice(-2)}`])]);
    expect(result.walkError).toBeNull();
    expect(result.members.get('a')).toEqual({ ok: true, rows: ['a@01', 'a@02'] });
    expect(result.members.get('b')).toEqual({ ok: true, rows: ['b@01', 'b@02'] });
    expect(h.statements.filter((s) => s.startsWith('01:'))).toEqual([
      '01: SAVEPOINT crewflow_combined_member',
      '01: a discovery',
      '01: RELEASE SAVEPOINT crewflow_combined_member',
      '01: SAVEPOINT crewflow_combined_member',
      '01: b discovery',
      '01: RELEASE SAVEPOINT crewflow_combined_member',
    ]);
    // T-1 / ST-02: each workspace transaction is READ ONLY through the tenant-context option (folded into the binding
    // SELECT, 25006 on any write: tenant-context-framing.integration.spec.ts), not a separate SET TRANSACTION READ ONLY.
    expect(h.options).toEqual([{ readOnly: true }, { readOnly: true }]);
    // The same trusted, server-derived worker context discoverInWorkspaces binds (no user, no role).
    expect(h.contexts).toEqual([
      { organisationId: ORG_A, workspaceId: ws(1), userId: '', role: '', actorType: 'worker' },
      { organisationId: ORG_B, workspaceId: ws(2), userId: '', role: '', actorType: 'worker' },
    ]);
    // Catalogue pages: READ ONLY, keyset after the last workspace id, page size 100.
    expect(h.pageParams).toEqual([[null, 100], [ws(2), 100]]);
  });

  it('a member failing in one workspace rolls back to its savepoint; the other members still run there; it is skipped afterwards', async () => {
    const h = harness([[{ workspace_id: ws(1), organisation_id: ORG_A }], [{ workspace_id: ws(2), organisation_id: ORG_A }]]);
    const boom = new Error('division by zero');
    const result = await h.run([member('a', () => ['a']), member('b', (w) => (w === ws(1) ? boom : ['b'])), member('c', () => ['c'])]);
    expect(result.members.get('b')).toEqual({ ok: false, error: boom });
    expect(result.members.get('a')).toEqual({ ok: true, rows: ['a', 'a'] });
    expect(result.members.get('c')).toEqual({ ok: true, rows: ['c', 'c'] });
    expect(h.statements.filter((s) => s.startsWith('01:'))).toEqual(
      expect.arrayContaining(['01: b discovery', '01: ROLLBACK TO SAVEPOINT crewflow_combined_member', '01: c discovery']),
    );
    expect(h.statements.indexOf('01: ROLLBACK TO SAVEPOINT crewflow_combined_member')).toBeLessThan(h.statements.indexOf('01: c discovery'));
    // Failed for the tick (separate mode would have thrown): not run again in the next workspace.
    expect(h.statements).not.toContain('02: b discovery');
    expect(result.walkError).toBeNull();
  });

  it('a not-yet-routable workspace is skipped for every member (as discoverInWorkspaces does)', async () => {
    const h = harness([[{ workspace_id: ws(1), organisation_id: ORG_A }, { workspace_id: ws(2), organisation_id: ORG_A }]], {
      contextError: (w) => (w === ws(1) ? new WorkspaceRoutingError('not-ready') : null),
    });
    const result = await h.run([member('a', (w) => [w.slice(-2)])]);
    expect(result).toEqual({ members: new Map([['a', { ok: true, rows: ['02'] }]]), walkError: null });
  });

  it('any other workspace failure is the walk error: the walk stops and every member fails with it (fail closed)', async () => {
    const integrity = new WorkspaceRoutingError('name-mismatch');
    const h = harness([[{ workspace_id: ws(1), organisation_id: ORG_A }], [{ workspace_id: ws(2), organisation_id: ORG_A }]], { contextError: (w) => (w === ws(1) ? integrity : null) });
    const result = await h.run([member('a', () => ['a']), member('b', () => ['b'])]);
    expect(result.walkError).toBe(integrity);
    expect(result.members.get('a')).toEqual({ ok: false, error: integrity });
    expect(result.members.get('b')).toEqual({ ok: false, error: integrity });
    expect(h.pageParams).toHaveLength(1); // stopped: no further catalogue page
  });

  it('a catalogue failure fails every member (no partial discovery is ever processed)', async () => {
    const down = new Error('connection refused');
    const h = harness([], { pageError: down });
    const result = await h.run([member('a', () => ['a'])]);
    expect(result).toEqual({ members: new Map([['a', { ok: false, error: down }]]), walkError: down });
  });

  it('runs at most 4 workspaces at a time (same CONCURRENCY as discoverInWorkspaces)', async () => {
    const page = Array.from({ length: 9 }, (_, i) => ({ workspace_id: ws(i + 1), organisation_id: ORG_A }));
    let active = 0;
    let peak = 0;
    const h = harness([page]);
    const slow: WalkMember = {
      key: 'slow',
      discover: async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((r) => setImmediate(r));
        active -= 1;
        return [1];
      },
    };
    const result = await h.run([slow]);
    expect(peak).toBe(4);
    expect(result.members.get('slow')).toEqual({ ok: true, rows: Array(9).fill(1) });
  });
});
