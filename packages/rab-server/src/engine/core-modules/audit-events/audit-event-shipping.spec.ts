import { AuditAction, AuditService } from '../audit/audit.service';
import { AuditEventShipper, registerAuditEventShipper, shipAuditRowAfterCommit, shipPreAuthSecurityEvent, unregisterAuditEventShipper } from './audit-event-shipping';
import { buildLoginFailedSecurityEvent } from './build-security-audit-event';

/**
 * X1.1 review (LOW 3b): the process-wide hand-off NEVER throws into the writer. A shipper that throws (synchronously) is
 * contained by the outer try/catch, so `AuditService.record` — and therefore the audited action — still succeeds.
 */
const ORG = '11111111-1111-4111-8111-111111111111';
const ROW = '44444444-4444-4444-8444-444444444444';

describe('audit-event shipping hand-off (X1.1)', () => {
  const throwing: AuditEventShipper = {
    afterCommit: () => {
      throw new Error('shipper exploded');
    },
    shipPreAuth: () => {
      throw new Error('shipper exploded');
    },
  };
  afterEach(() => unregisterAuditEventShipper(throwing));

  it('a throwing shipper is contained: shipAuditRowAfterCommit returns false, shipPreAuthSecurityEvent returns', () => {
    registerAuditEventShipper(throwing);
    expect(() => shipAuditRowAfterCommit({} as never, { organisationId: ORG, auditLogId: ROW, action: AuditAction.USER_DELETED })).not.toThrow();
    expect(shipAuditRowAfterCommit({} as never, { organisationId: ORG, auditLogId: ROW, action: AuditAction.USER_DELETED })).toBe(false);
    expect(() => shipPreAuthSecurityEvent(buildLoginFailedSecurityEvent({ email: 'a@b.co', reason: 'invalid_credentials', provider: 'password' }, 'api'))).not.toThrow();
  });

  it('AuditService.record still resolves (the action is never failed) when the shipper throws', async () => {
    registerAuditEventShipper(throwing);
    const saved: unknown[] = [];
    const manager = {
      query: async () => [], // core.audit_identity_violations: none
      create: (_entity: unknown, values: Record<string, unknown>) => ({ ...values }),
      save: async (entry: Record<string, unknown>) => {
        entry.id = ROW;
        saved.push(entry);
        return entry;
      },
    };
    const service = new AuditService({} as never);
    await expect(service.record(manager as never, { organisationId: ORG, userId: '' }, AuditAction.USER_DELETED, { actorUserId: null })).resolves.toBeUndefined();
    expect(saved).toHaveLength(1);
  });

  it('with no shipper registered (no sink configured) both calls are no-ops', () => {
    expect(shipAuditRowAfterCommit({} as never, { organisationId: ORG, auditLogId: ROW, action: AuditAction.USER_DELETED })).toBe(false);
    expect(() => shipPreAuthSecurityEvent(buildLoginFailedSecurityEvent({ email: 'a@b.co', reason: 'invalid_credentials', provider: 'password' }, 'api'))).not.toThrow();
  });
});
