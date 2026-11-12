import { AuditEventShipper, registerAuditEventShipper, unregisterAuditEventShipper } from '../audit-events/audit-event-shipping';
import { OutboxOperationsService } from './outbox-operations.service';

/**
 * X1.1 review (LOW 3a): `core.replay_failed_email` writes its own `email.replay_requested` audit row (frozen SQL, no id
 * returned). The caller finds that row in the SAME transaction and hands it to the shipper on the same manager, so a
 * platform-admin e-mail replay reaches the sink like every other security action. Mocked database.
 */
const ORG = '11111111-1111-4111-8111-111111111111';
const ADMIN = '22222222-2222-4222-8222-222222222222';
const EMAIL = '33333333-3333-4333-8333-333333333333';
const REPLAY_ROW = '44444444-4444-4444-8444-444444444444';

function build(replayResult: string) {
  const statements: Array<{ sql: string; params: unknown[] }> = [];
  const manager = {
    query: async (sql: string, params: unknown[] = []) => {
      statements.push({ sql, params });
      if (sql.includes('core.replay_failed_email')) return [{ r: replayResult }];
      if (sql.includes('dispatch_generation AS g')) return [{ g: 3 }];
      if (sql.includes("action = 'email.replay_requested'")) return [{ id: REPLAY_ROW }];
      return [];
    },
  };
  const tenantContext = { runInTenantContext: async <T>(_ctx: unknown, fn: (m: unknown) => Promise<T>) => fn(manager) };
  const platformAdmin = { isPlatformAdmin: async () => true };
  const emailQueue = { republish: jest.fn(async () => undefined) };
  const audit = { record: jest.fn(async () => undefined) };
  const service = new OutboxOperationsService({} as never, tenantContext as never, platformAdmin as never, {} as never, {} as never, emailQueue as never, {} as never, audit as never);
  return { service, manager, statements };
}

describe('admin e-mail replay → audit events (X1.1)', () => {
  const calls: Array<{ manager: unknown; row: { organisationId: string; auditLogId: string; action: string } }> = [];
  const shipper: AuditEventShipper = { afterCommit: (manager, row) => (calls.push({ manager, row }), true), shipPreAuthLoginFailure: () => undefined };
  beforeEach(() => {
    calls.length = 0;
    registerAuditEventShipper(shipper);
  });
  afterEach(() => unregisterAuditEventShipper(shipper));

  it("REPLAYED: the function's email.replay_requested row is found in the same transaction and handed to the shipper", async () => {
    const { service, manager, statements } = build('REPLAYED');
    await expect(service.replayFailedEmailRaw({ userId: ADMIN }, ORG, EMAIL)).resolves.toBe('REPLAYED');
    expect(calls).toEqual([{ manager, row: { organisationId: ORG, auditLogId: REPLAY_ROW, action: 'email.replay_requested' } }]);
    const lookup = statements.find((s) => s.sql.includes("action = 'email.replay_requested'"))!;
    expect(lookup.sql).toContain('transaction_timestamp()');
    expect(lookup.params).toEqual([EMAIL, ADMIN]);
  });

  it.each(['NOT_FOUND', 'NO_BODY', 'UNCERTAIN'])('%s: no replay row was written, nothing is looked up or shipped', async (result) => {
    const { service, statements } = build(result);
    await service.replayFailedEmailRaw({ userId: ADMIN }, ORG, EMAIL);
    expect(calls).toEqual([]);
    expect(statements.some((s) => s.sql.includes("action = 'email.replay_requested'"))).toBe(false);
  });
});
