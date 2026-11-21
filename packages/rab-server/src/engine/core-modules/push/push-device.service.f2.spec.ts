import { PUSH_TOKEN_LOCK_SQL, PushDeviceService } from './push-device.service';

/**
 * C1 review F2 (review of #303), without a database: the registration takes the per-token advisory lock before it reads
 * anything, supersedes another account's row only with the organisation predicate from the verified context (layer 3, in
 * addition to FORCE RLS) and every fingerprint candidate, and writes the active fingerprint on BOTH the insert and the
 * refresh path.
 */
type Call = { op: string; sql?: string; params?: unknown; where?: string; set?: Record<string, unknown> };

function harness(existing: { id: string } | null) {
  const calls: Call[] = [];
  const updateBuilder = () => {
    const call: Call = { op: 'qb-update' };
    const b = {
      update: () => b,
      set: (set: Record<string, unknown>) => ((call.set = set), b),
      where: (where: string, params: unknown) => ((call.where = where), (call.params = params), b),
      execute: async () => (calls.push(call), { affected: 0 }),
    };
    return b;
  };
  const selectBuilder = () => {
    const b = { addSelect: () => b, where: (where: string, params: unknown) => (calls.push({ op: 'qb-select', where, params }), b), getMany: async () => [] };
    return b;
  };
  const manager = {
    query: async (sql: string, params: unknown) => (calls.push({ op: 'query', sql, params }), []),
    findOne: async () => (calls.push({ op: 'findOne' }), existing),
    createQueryBuilder: (entity?: unknown) => (entity ? selectBuilder() : updateBuilder()),
    update: async (_e: unknown, where: unknown, set: Record<string, unknown>) => (calls.push({ op: 'update', params: where, set }), undefined),
    create: (_e: unknown, row: Record<string, unknown>) => row,
    save: async (row: Record<string, unknown>) => (calls.push({ op: 'save', set: row }), Object.assign(row, { id: 'new-id' })),
  };
  const tenantContext = { runInTenantContext: async (_ctx: unknown, fn: (m: typeof manager) => unknown) => fn(manager) };
  const active = Buffer.alloc(32, 7);
  const previous = Buffer.alloc(32, 9);
  const secretEncryption = {
    encrypt: () => Buffer.from('cipher'),
    decrypt: () => 'other-token',
    pushTokenFingerprint: () => active,
    pushTokenFingerprintCandidates: () => [active, previous],
    pushTokenLockKey: () => 424242,
  };
  const service = new PushDeviceService(tenantContext as never, secretEncryption as never);
  return { service, calls, active, previous };
}

const CTX = { organisationId: 'org-1', workspaceId: null, userId: 'user-1', role: '' } as never;
const PARAMS = { deviceId: 'device-1', platform: 'android' as const, pushToken: 'fcm-token' };

describe('PushDeviceService.register — C1 review F2', () => {
  it('takes the per-token advisory lock FIRST, keyed by the kid-independent lock key', async () => {
    const h = harness(null);
    await h.service.register(CTX, PARAMS);
    expect(h.calls[0]).toEqual({ op: 'query', sql: PUSH_TOKEN_LOCK_SQL, params: [424242] });
    expect(PUSH_TOKEN_LOCK_SQL).toMatch(/pg_advisory_xact_lock\(pg_catalog\.hashtext\('crewflow_push_token_fingerprint'\), \$1::int4\)/);
  });

  it('supersedes another account only with organisation_id from the context, every candidate fingerprint, and user_id <> caller', async () => {
    const h = harness(null);
    await h.service.register(CTX, PARAMS);
    const supersede = h.calls.find((c) => c.op === 'qb-update' && c.set?.deactivatedReason === 'token_registered_by_another_account')!;
    expect(supersede.where).toBe('organisation_id = :organisationId AND token_fingerprint IN (:...fingerprints) AND user_id <> :userId AND active = true');
    expect(supersede.params).toEqual({ organisationId: 'org-1', fingerprints: [h.active, h.previous], userId: 'user-1' });
  });

  it('writes the active fingerprint on the insert path', async () => {
    const h = harness(null);
    await h.service.register(CTX, PARAMS);
    expect(h.calls.find((c) => c.op === 'save')!.set!.tokenFingerprint).toBe(h.active);
  });

  it('writes the active fingerprint on the refresh path (existing row), so a pre-migration row gains one', async () => {
    const h = harness({ id: 'row-1' });
    await expect(h.service.register(CTX, PARAMS)).resolves.toEqual({ id: 'row-1' });
    const refresh = h.calls.find((c) => c.op === 'update' && (c.params as { id?: string }).id === 'row-1')!;
    expect(refresh.set!.tokenFingerprint).toBe(h.active);
    expect(refresh.set!.active).toBe(true);
  });

});
