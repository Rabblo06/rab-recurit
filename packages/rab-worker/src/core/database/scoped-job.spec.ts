import { runScopedForOrg } from './scoped-job';

/**
 * T-1 review F1(a): `runScopedForOrg` is the one way a Worker job binds a row's organisation + workspace. Since T-1 the
 * D-Q4b timer decision no longer sends its own SET TRANSACTION READ ONLY: read-only reaches PostgreSQL only through the
 * `readOnly` option this helper passes on. Dropping it here would silently make the decision read-write.
 */
describe('runScopedForOrg', () => {
  function tenant() {
    const calls: Array<{ ctx: unknown; options: unknown }> = [];
    return {
      calls,
      service: {
        runInTenantContext: jest.fn(async (ctx: unknown, fn: (m: unknown) => Promise<unknown>, options?: unknown) => {
          calls.push({ ctx, options });
          return fn({});
        }),
      },
    };
  }
  const ORG = '00000000-0000-4000-8000-0000000000a1';
  const WS = '00000000-0000-4000-8000-0000000000a2';

  it('binds the worker context (no user, no role) and returns the callback result', async () => {
    const t = tenant();
    await expect(runScopedForOrg(t.service as never, ORG, WS, async () => 42)).resolves.toBe(42);
    expect(t.calls).toEqual([{ ctx: { organisationId: ORG, workspaceId: WS, userId: '', role: '', actorType: 'worker' }, options: undefined }]);
  });

  it('passes { readOnly: true } through to runInTenantContext when asked (the timer decision)', async () => {
    const t = tenant();
    await runScopedForOrg(t.service as never, ORG, WS, async () => undefined, { readOnly: true });
    expect(t.calls[0]!.options).toEqual({ readOnly: true });
  });

  it('passes only readOnly: nothing else a caller sneaks in (useReplica is never a Worker option)', async () => {
    const t = tenant();
    await runScopedForOrg(t.service as never, ORG, WS, async () => undefined, { readOnly: true, useReplica: true } as never);
    expect(t.calls[0]!.options).toEqual({ readOnly: true });
    await runScopedForOrg(t.service as never, ORG, WS, async () => undefined, { useReplica: true } as never);
    expect(t.calls[1]!.options).toBeUndefined();
  });
});
