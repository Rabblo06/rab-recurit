import {
  AI_STALE_SWEEP_MAX_FINALISED_PER_CYCLE,
  AI_STALE_SWEEP_USER_PAGE_SIZE,
  AiStaleTurnSweepService,
} from './ai-stale-turn-sweep.service';

/**
 * Phase D-Q2 unit contract (no database): off by default; refuses an unsafe threshold; discovery only through the
 * catalogue and per-(organisation, workspace, user) tenant contexts; finalisation only through the runner's CAS; bounded;
 * one failing scope never stops the cycle.
 */
const ORG = '00000000-0000-4000-8000-0000000000a1';
const WS = '00000000-0000-4000-8000-0000000000b1';
const WS2 = '00000000-0000-4000-8000-0000000000b2';
const U1 = '00000000-0000-4000-8000-0000000000c1';

function harness(
  opts: {
    flag?: unknown;
    minutes?: number;
    safe?: boolean;
    turns?: number;
    failWorkspace?: string;
    /** Eligible users per workspace, served in keyset pages ($3 = limit, $4 = cursor) like the real query. */
    users?: string[];
  } = {},
) {
  const contexts: Array<{
    organisationId: string;
    workspaceId: string | null;
    userId: string;
  }> = [];
  const catalogue = {
    query: jest.fn(async (sql: string, params: unknown[]) => {
      if (sql.includes('worker_list_organisations'))
        return params[0] === null ? [{ organisation_id: ORG }] : [];
      if (sql.includes('worker_list_workspaces'))
        return params[0] === null
          ? [
              { workspace_id: WS, organisation_id: ORG },
              { workspace_id: WS2, organisation_id: ORG },
            ]
          : [];
      return [];
    }),
  };
  const tenantContext = {
    runInTenantContext: jest.fn(
      async (
        ctx: {
          organisationId: string;
          workspaceId: string | null;
          userId: string;
        },
        fn: (m: unknown) => unknown,
      ) => {
        contexts.push({
          organisationId: ctx.organisationId,
          workspaceId: ctx.workspaceId,
          userId: ctx.userId,
        });
        if (opts.failWorkspace && ctx.workspaceId === opts.failWorkspace)
          throw new Error('not routable');
        return fn({
          query: async (sql: string, params: unknown[] = []) => {
            if (sql.includes('manager_workspace')) {
              const all = [...(opts.users ?? [U1])].sort();
              const after = params[3] as string | null;
              return all
                .filter((u) => after === null || u > after)
                .slice(0, params[2] as number)
                .map((user_id) => ({ user_id }));
            }
            if (sql.includes("status = 'queued'"))
              return Array.from({ length: opts.turns ?? 1 }, (_, i) => ({
                id: `t-${ctx.workspaceId}-${i}`,
                conversation_id: `c-${i}`,
              }));
            return [];
          },
        });
      },
    ),
  };
  const runner = {
    isSafeStaleQueuedThreshold: jest.fn(() => opts.safe ?? true),
    finaliseStaleQueued: jest.fn(async () => true),
  };
  const env = {
    get: jest.fn((k: string) =>
      k === 'AI_STALE_TURN_SWEEP'
        ? ('flag' in opts ? opts.flag : true)
        : k === 'AI_STALE_TURN_THRESHOLD_MINUTES'
          ? (opts.minutes ?? 15)
          : undefined,
    ),
  };
  const service = new AiStaleTurnSweepService(
    tenantContext as never,
    runner as never,
    env as never,
  );
  return { service, catalogue, tenantContext, runner, contexts };
}

describe('AiStaleTurnSweepService (D-Q2)', () => {
  it('off unless AI_STALE_TURN_SWEEP is exactly true: nothing is read at all', async () => {
    for (const flag of [false, undefined, 'true', 1]) {
      const h = harness({ flag });
      const r = await h.service.runCycle(h.catalogue as never);
      expect(r).toMatchObject({ ran: false, finalised: 0 });
      expect(h.catalogue.query).not.toHaveBeenCalled();
      expect(h.tenantContext.runInTenantContext).not.toHaveBeenCalled();
    }
  });

  it('refuses to run when the threshold does not exceed the legitimate queued wait (fail closed)', async () => {
    const h = harness({ safe: false });
    const r = await h.service.runCycle(h.catalogue as never);
    expect(r.ran).toBe(false);
    expect(h.catalogue.query).not.toHaveBeenCalled();
    expect(h.runner.isSafeStaleQueuedThreshold).toHaveBeenCalledWith(
      15 * 60_000,
    );
  });

  it('never binds an organisation-only context; each turn is finalised under its own (org, workspace, user) binding via the runner CAS', async () => {
    const h = harness();
    const r = await h.service.runCycle(h.catalogue as never);
    expect(h.contexts.every((c) => c.workspaceId !== null)).toBe(true);
    expect(h.contexts).toEqual([
      { organisationId: ORG, workspaceId: WS, userId: '' },
      { organisationId: ORG, workspaceId: WS, userId: U1 },
      { organisationId: ORG, workspaceId: WS2, userId: '' },
      { organisationId: ORG, workspaceId: WS2, userId: U1 },
    ]);
    expect(h.runner.finaliseStaleQueued.mock.calls).toEqual([
      [
        {
          turnId: `t-${WS}-0`,
          conversationId: 'c-0',
          organisationId: ORG,
          workspaceId: WS,
          userId: U1,
        },
        15 * 60_000,
      ],
      [
        {
          turnId: `t-${WS2}-0`,
          conversationId: 'c-0',
          organisationId: ORG,
          workspaceId: WS2,
          userId: U1,
        },
        15 * 60_000,
      ],
    ]);
    expect(r).toMatchObject({
      ran: true,
      workspaces: 2,
      users: 2,
      candidates: 2,
      finalised: 2,
      skipped: 0,
    });
  });

  it('a workspace that cannot be bound is skipped; the cycle carries on', async () => {
    const h = harness({ failWorkspace: WS });
    const r = await h.service.runCycle(h.catalogue as never);
    expect(r).toMatchObject({ skipped: 1, finalised: 1 });
  });

  it('a turn lost to another replica (CAS false) is not counted; a throwing finalisation does not stop the cycle', async () => {
    const h = harness({ turns: 3 });
    h.runner.finaliseStaleQueued
      .mockResolvedValueOnce(false)
      .mockRejectedValueOnce(new Error('redis'))
      .mockResolvedValue(true);
    const r = await h.service.runCycle(h.catalogue as never);
    expect(r.candidates).toBe(6);
    expect(r.finalised).toBe(4);
  });

  it('every eligible user is examined, past the first page (keyset pagination; CodeRabbit on #46)', async () => {
    const users = Array.from(
      { length: 2 * AI_STALE_SWEEP_USER_PAGE_SIZE + 5 },
      (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    );
    const h = harness({ users });
    const r = await h.service.runCycle(h.catalogue as never);
    // Two workspaces, 45 users each: 3 discovery pages per workspace, every user bound once with its own context.
    const discovery = h.contexts.filter((c) => c.userId === '');
    expect(discovery).toHaveLength(6);
    for (const ws of [WS, WS2]) {
      expect(
        h.contexts.filter((c) => c.workspaceId === ws && c.userId !== '').map((c) => c.userId),
      ).toEqual(users);
    }
    expect(r).toMatchObject({ users: 90, finalised: 90, skipped: 0 });
  });

  it('a page size of users exactly fills one page: one extra (empty) page read, nobody examined twice', async () => {
    const users = Array.from(
      { length: AI_STALE_SWEEP_USER_PAGE_SIZE },
      (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    );
    const h = harness({ users });
    const r = await h.service.runCycle(h.catalogue as never);
    expect(h.contexts.filter((c) => c.userId === '')).toHaveLength(4);
    expect(r.users).toBe(2 * AI_STALE_SWEEP_USER_PAGE_SIZE);
  });

  it('bounded: never more than the per-cycle cap', async () => {
    const h = harness({ turns: 20 });
    const r = await h.service.runCycle(h.catalogue as never, {
      maxFinalised: 5,
    });
    expect(r.finalised).toBe(5);
    expect(h.runner.finaliseStaleQueued).toHaveBeenCalledTimes(5);
    expect(AI_STALE_SWEEP_MAX_FINALISED_PER_CYCLE).toBe(200);
  });
});
