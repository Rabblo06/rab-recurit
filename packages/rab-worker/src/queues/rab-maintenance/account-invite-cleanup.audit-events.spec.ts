import { AuditEventShipper, registerAuditEventShipper, unregisterAuditEventShipper } from '@rab/server/engine/core-modules/audit-events/audit-event-shipping';
import { runAccountInviteCleanupCycle } from './account-invite-cleanup.job';

/**
 * X1.1: the Worker's direct `INSERT INTO core.audit_log` (account-invite cleanup) takes the same off-host path as
 * AuditService.record — the inserted row's id is handed to the process shipper on the SAME transaction manager (queued
 * after its commit). Mocked database (the definers are not executed here).
 */
const ORG = '00000000-0000-4000-8000-00000000000a';
const USER = '00000000-0000-4000-8000-000000000021';
const AUDIT_ID = '00000000-0000-4000-8000-0000000000f1';

describe('account invite cleanup → audit events (X1.1)', () => {
  const calls: Array<{ manager: unknown; row: { organisationId: string; auditLogId: string; action: string } }> = [];
  const shipper: AuditEventShipper = { afterCommit: (manager, row) => (calls.push({ manager, row }), true), shipPreAuthLoginFailure: () => undefined };
  beforeEach(() => {
    calls.length = 0;
    registerAuditEventShipper(shipper);
  });
  afterEach(() => unregisterAuditEventShipper(shipper));

  it('an invited account deleted by the cleanup hands its user.invite_cleaned_up row to the shipper, on the same transaction', async () => {
    let served = false;
    const manager = {
      query: async (sql: string) => {
        if (sql.includes('has_function_privilege')) return [{ usable: true }];
        if (sql.includes('core.worker_expire_account_invites')) return [];
        if (sql.includes('core.worker_account_invite_cleanup_candidates')) {
          if (served) return [];
          served = true;
          return [{ user_id: USER, organisation_id: ORG, cleanup_at: new Date(), blocking_reason: null }];
        }
        if (sql.includes('core.worker_list_workspaces')) return [];
        if (sql.includes('core.worker_delete_expired_invited_user')) return [{ outcome: 'deleted' }];
        if (sql.includes('INSERT INTO core.audit_log')) {
          expect(sql).toContain('RETURNING id');
          return [{ id: AUDIT_ID }];
        }
        if (sql.startsWith('SELECT current_setting')) return [{ org: null, workspace: null }];
        return [];
      },
    };
    const dataSource = { transaction: async <T>(fn: (m: unknown) => Promise<T>) => fn(manager), query: manager.query };
    const result = await runAccountInviteCleanupCycle(dataSource as never, { autoDeleteEnabled: true });
    expect(result.deleted).toBe(1);
    expect(calls.map((c) => c.row)).toEqual([{ organisationId: ORG, auditLogId: AUDIT_ID, action: 'user.invite_cleaned_up' }]);
    expect(calls[0]!.manager).toBe(manager);
  });

  it('an INSERT that returns no id (mocked / unexpected) hands nothing over and never fails the cycle', async () => {
    let served = false;
    const manager = {
      query: async (sql: string) => {
        if (sql.includes('has_function_privilege')) return [{ usable: true }];
        if (sql.includes('core.worker_account_invite_cleanup_candidates')) {
          if (served) return [];
          served = true;
          return [{ user_id: USER, organisation_id: ORG, cleanup_at: new Date(), blocking_reason: null }];
        }
        if (sql.includes('core.worker_delete_expired_invited_user')) return [{ outcome: 'deleted' }];
        if (sql.startsWith('SELECT current_setting')) return [{ org: null, workspace: null }];
        return []; // includes the audit INSERT: no id returned
      },
    };
    const dataSource = { transaction: async <T>(fn: (m: unknown) => Promise<T>) => fn(manager), query: manager.query };
    await expect(runAccountInviteCleanupCycle(dataSource as never, { autoDeleteEnabled: true })).resolves.toMatchObject({ deleted: 1 });
    expect(calls).toEqual([]);
  });
});
