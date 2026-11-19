import { DataSource, EntityManager } from 'typeorm';

import { AuditAction, AuditService } from '../../../../engine/core-modules/audit/audit.service';
import { AccountLifecycleService } from '../../../../engine/core-modules/auth/services/account-lifecycle.service';
import { TenantContextService } from '../../../../engine/core-modules/tenant/tenant-context.service';
import { PlatformAdminBootstrapError, PlatformAdminBootstrapInput, PlatformAdminBootstrapService } from '../services/platform-admin-bootstrap.service';

/**
 * Unit spec (no database) for the shared bootstrap service: which writes each database answer leads to, and that the one
 * activation email is addressed to the configured email only. The same guarantees against PostgreSQL (one-time, advisory
 * lock, outbox rows) are in bootstrap-admin.integration.spec.ts, bootstrap-admin-crewflow-identity.integration.spec.ts and
 * bootstrap-admin-at-boot.integration.spec.ts.
 */
describe('PlatformAdminBootstrapService (shared by bootstrap-admin and the API boot)', () => {
  const input: PlatformAdminBootstrapInput = { email: 'only-me@example.test', firstName: 'Admin', lastName: '', orgSlug: null, orgName: null };
  let queries: string[];
  let manager: jest.Mocked<Pick<EntityManager, 'query' | 'findOne' | 'insert' | 'findOneByOrFail'>>;
  let audit: { record: jest.Mock };
  let lifecycle: { sendAccountInvite: jest.Mock };
  let tenant: { bindCoreIdentityGucs: jest.Mock };
  let service: PlatformAdminBootstrapService;

  function answer(row: Record<string, unknown> | undefined, allowed: boolean | null = true): void {
    manager.query.mockImplementation(async (sql: string) => {
      queries.push(sql);
      if (sql.includes('has_function_privilege')) return [{ who: 'crewflow_owner', allowed }];
      if (sql.includes('core.bootstrap_first_platform_admin')) return row ? [row] : [];
      // revokeSessionsForPrivilegedGrant (GRANTED_EXISTING): the target's organisation, the previous binding, two UPDATEs.
      if (sql.includes('resolve_membership_for_user')) return [{ organisation_id: 'o1' }];
      if (sql.includes('current_setting')) return [{ previous: 'o1' }];
      if (sql.startsWith('UPDATE') || sql.includes('UPDATE core.user_session')) return [[], 0];
      return [];
    });
  }

  beforeEach(() => {
    queries = [];
    manager = { query: jest.fn(), findOne: jest.fn().mockResolvedValue({ id: 'profile' }), insert: jest.fn(), findOneByOrFail: jest.fn() } as never;
    audit = { record: jest.fn() };
    lifecycle = { sendAccountInvite: jest.fn().mockResolvedValue({ queued: true, sendNumber: 1, expiresAt: new Date('2026-11-20T00:00:00Z') }) };
    tenant = { bindCoreIdentityGucs: jest.fn() };
    const dataSource = { transaction: jest.fn(async (fn: (m: EntityManager) => Promise<unknown>) => fn(manager as unknown as EntityManager)) } as unknown as DataSource;
    service = new PlatformAdminBootstrapService(
      dataSource,
      audit as unknown as AuditService,
      lifecycle as unknown as AccountLifecycleService,
      tenant as unknown as TenantContextService,
    );
  });

  it('CREATED_INVITED: queues exactly ONE activation email, addressed to the configured email only, and audits it (api_boot)', async () => {
    answer({ outcome: 'CREATED_INVITED', user_id: 'u1', organisation_id: 'o1', created_user: true, created_organisation: true });
    const result = await service.run(input, { trigger: 'api_boot', selfHealExistingAdmin: false });
    expect(result).toEqual({ outcome: 'CREATED_INVITED', userId: 'u1', organisationId: 'o1', createdOrganisation: true, activationExpiresAt: new Date('2026-11-20T00:00:00Z') });
    expect(lifecycle.sendAccountInvite).toHaveBeenCalledTimes(1);
    const [, ctx, params, opts] = lifecycle.sendAccountInvite.mock.calls[0]!;
    expect(params).toEqual({ userId: 'u1', email: 'only-me@example.test', createdBy: null });
    expect(ctx).toMatchObject({ organisationId: 'o1', userId: 'u1' });
    expect(opts).toMatchObject({ actorUserId: null });
    expect(audit.record).toHaveBeenCalledTimes(1);
    expect(audit.record.mock.calls[0]![2]).toBe(AuditAction.PLATFORM_ADMIN_BOOTSTRAPPED);
    expect(audit.record.mock.calls[0]![3]).toMatchObject({ actorUserId: null, targetUserId: 'u1', metadata: { via: 'env_bootstrap', pendingActivation: true, trigger: 'api_boot' } });
  });

  it('the CLI trigger keeps its historical audit metadata (no trigger key)', async () => {
    answer({ outcome: 'CREATED_INVITED', user_id: 'u1', organisation_id: 'o1', created_user: true, created_organisation: false });
    await service.run(input, { trigger: 'command', selfHealExistingAdmin: true });
    expect(audit.record.mock.calls[0]![3].metadata).toEqual({ via: 'env_bootstrap', pendingActivation: true, createdOrganisation: false });
  });

  it('ALREADY_BOOTSTRAPPED without self-heal (the API boot): writes NOTHING and queues no email', async () => {
    answer({ outcome: 'ALREADY_BOOTSTRAPPED', user_id: 'u1', organisation_id: 'o1', created_user: false, created_organisation: false });
    expect(await service.run(input, { trigger: 'api_boot', selfHealExistingAdmin: false })).toEqual({ outcome: 'ALREADY_BOOTSTRAPPED', userId: 'u1', organisationId: 'o1' });
    expect(lifecycle.sendAccountInvite).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
    expect(tenant.bindCoreIdentityGucs).not.toHaveBeenCalled();
    expect(manager.findOne).not.toHaveBeenCalled();
    expect(manager.insert).not.toHaveBeenCalled();
    expect(queries).toHaveLength(2); // the authority check and the function call, nothing else
  });

  it('ALREADY_BOOTSTRAPPED with self-heal (the CLI, unchanged): checks the operational identity, still no email or audit', async () => {
    answer({ outcome: 'ALREADY_BOOTSTRAPPED', user_id: 'u1', organisation_id: 'o1', created_user: false, created_organisation: false });
    await service.run(input, { trigger: 'command', selfHealExistingAdmin: true });
    expect(tenant.bindCoreIdentityGucs).toHaveBeenCalledTimes(1);
    expect(manager.findOne).toHaveBeenCalledTimes(1);
    expect(lifecycle.sendAccountInvite).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it.each(['CLOSED', 'REFUSED_AMBIGUOUS_EMAIL', 'REFUSED_AMBIGUOUS_ORGANISATION'])('%s: returned, nothing written, no email', async (outcome) => {
    answer({ outcome, user_id: null, organisation_id: null, created_user: false, created_organisation: false });
    expect(await service.run(input, { trigger: 'api_boot', selfHealExistingAdmin: false })).toEqual({ outcome });
    expect(lifecycle.sendAccountInvite).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
    expect(manager.insert).not.toHaveBeenCalled();
  });

  it('GRANTED_EXISTING: no email (the account can already sign in), audited', async () => {
    answer({ outcome: 'GRANTED_EXISTING', user_id: 'u1', organisation_id: 'o1', created_user: false, created_organisation: false });
    const events: string[] = [];
    expect(await service.run(input, { trigger: 'api_boot', selfHealExistingAdmin: false, onEvent: (e) => events.push(e.kind) })).toMatchObject({ outcome: 'GRANTED_EXISTING' });
    expect(lifecycle.sendAccountInvite).not.toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledTimes(1);
    expect(events).toEqual(['granting-existing-user']);
  });

  it('DENIAL: a login that may not EXECUTE the function is refused before the function is called', async () => {
    answer(undefined, false);
    await expect(service.run(input, { trigger: 'api_boot', selfHealExistingAdmin: false })).rejects.toMatchObject({ reason: 'NOT_AUTHORISED' });
    expect(queries.some((q) => q.includes('FROM core.bootstrap_first_platform_admin'))).toBe(false);
    answer(undefined, null);
    await expect(service.run(input, { trigger: 'api_boot', selfHealExistingAdmin: false })).rejects.toBeInstanceOf(PlatformAdminBootstrapError);
  });

  it('fail closed on an unknown database answer (the transaction rolls back)', async () => {
    answer({ outcome: 'SOMETHING_NEW', user_id: 'u1', organisation_id: 'o1', created_user: true, created_organisation: false });
    await expect(service.run(input, { trigger: 'api_boot', selfHealExistingAdmin: false })).rejects.toMatchObject({ reason: 'UNEXPECTED_OUTCOME' });
    expect(lifecycle.sendAccountInvite).not.toHaveBeenCalled();
  });
});
