import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { AuditAction } from '../audit/audit.service';
import { PRIVILEGED_COPY_AUDIT_ACTION, PRIVILEGED_COPY_SKIPPED_AUDIT_ACTION } from '../../../database/typeorm/workspace-schema/backfill/privileged-copy';
import { classifyAuditAction, LOGIN_FAILED_EVENT_TYPE, NOT_SHIPPED_AUDIT_ACTIONS, SECURITY_AUDIT_CATEGORIES, SHIPPED_AUDIT_ACTIONS } from './security-audit-event-catalogue';

/**
 * X1.1: every action that can reach core.audit_log has ONE decision (shipped off-host or not), and the owner's event list
 * (logins success+fail, MFA, password reset, grants/revokes, role and permission changes, platform-admin actions, payroll
 * approval, account deletion, suspension, security configuration) is covered.
 */
const shipped = Object.keys(SHIPPED_AUDIT_ACTIONS);
const repoFile = (rel: string) => readFileSync(join(__dirname, '../../../../../..', rel), 'utf8');

describe('security audit event catalogue (X1.1)', () => {
  it('every AuditAction is classified exactly once: shipped XOR deliberately not shipped', () => {
    const notShipped = new Set(NOT_SHIPPED_AUDIT_ACTIONS);
    expect(notShipped.size).toBe(NOT_SHIPPED_AUDIT_ACTIONS.length); // no duplicates
    expect(shipped.filter((a) => notShipped.has(a))).toEqual([]); // no overlap
    const unclassified = Object.values(AuditAction).filter((a) => !notShipped.has(a) && !(a in SHIPPED_AUDIT_ACTIONS));
    expect(unclassified).toEqual([]);
  });

  it('the actions the Worker and SQL write directly (not AuditAction constants) are classified too', () => {
    const direct = new Set<string>();
    for (const file of ['packages/rab-worker/src/queues/rab-email/email-dispatch.job.ts', 'packages/rab-worker/src/queues/rab-maintenance/account-invite-cleanup.job.ts']) {
      const src = repoFile(file);
      // writeAuditRow(manager, org, id, 'action', ...) — possibly across lines.
      for (const m of src.matchAll(/writeAuditRow\(\s*[^;]*?'([a-z_]+\.[a-z_]+)'/g)) direct.add(m[1]!);
    }
    expect(direct.size).toBeGreaterThanOrEqual(6);
    direct.add('email.replay_requested'); // core.replay_failed_email (outbox-retention-sql.ts)
    expect(repoFile('packages/rab-server/src/database/typeorm/core/outbox-retention-sql.ts')).toContain("'email.replay_requested'");
    direct.add(PRIVILEGED_COPY_AUDIT_ACTION);
    direct.add(PRIVILEGED_COPY_SKIPPED_AUDIT_ACTION);
    const known = new Set([...shipped, ...NOT_SHIPPED_AUDIT_ACTIONS]);
    expect([...direct].filter((a) => !known.has(a))).toEqual([]);
  });

  it("covers every category of the owner's list", () => {
    const byCategory = new Map<string, string[]>();
    for (const [action, { category }] of Object.entries(SHIPPED_AUDIT_ACTIONS)) byCategory.set(category, [...(byCategory.get(category) ?? []), action]);
    expect([...byCategory.keys()].sort()).toEqual([...SECURITY_AUDIT_CATEGORIES].sort());
    const expected: Record<string, string[]> = {
      login: [AuditAction.USER_LOGIN, LOGIN_FAILED_EVENT_TYPE, AuditAction.APPLICATION_ACCESS_DENIED, AuditAction.REFRESH_TOKEN_REUSE_DETECTED],
      mfa: [AuditAction.MFA_CHALLENGE_FAILED, AuditAction.MFA_ENABLED, AuditAction.MFA_DISABLED, AuditAction.MFA_RESET_BY_ADMIN],
      password: [AuditAction.PASSWORD_RESET_REQUESTED, AuditAction.PASSWORD_RESET_COMPLETED, AuditAction.ADMIN_PASSWORD_RESET, AuditAction.PASSWORD_CHANGED],
      access_grant: [AuditAction.PLATFORM_ADMIN_GRANTED, AuditAction.PLATFORM_ADMIN_REVOKED, AuditAction.MEMBER_INVITATION_REVOKED, AuditAction.MANAGER_VENUE_ASSIGNED],
      role_permission: [AuditAction.ROLE_PERMISSIONS_UPDATED, AuditAction.MEMBER_ROLE_CHANGED, AuditAction.ROLE_DELETED],
      platform_admin: [AuditAction.ADMIN_INSPECT_STARTED, AuditAction.ADMIN_SESSIONS_REVOKED, AuditAction.ORGANISATION_CREATED, 'email.replay_requested'],
      payroll_approval: [AuditAction.PAYROLL_RECORD_APPROVED, AuditAction.PAYROLL_RECORD_REJECTED, AuditAction.PAYROLL_RUN_FINALISED],
      account_deletion: [AuditAction.USER_DELETED, AuditAction.ACCOUNT_INVITE_CLEANED_UP],
      suspension: [AuditAction.ACCOUNT_SUSPENDED, AuditAction.MEMBER_SUSPENDED, AuditAction.ORGANISATION_SUSPENDED, AuditAction.ACCOUNT_REACTIVATED],
      security_configuration: [AuditAction.ORGANISATION_AUTH_PROVIDERS_UPDATED, AuditAction.PLATFORM_CONFIG_SMTP_UPDATED, AuditAction.WORKSPACE_SUBDOMAIN_CHANGED],
    };
    for (const [category, actions] of Object.entries(expected)) {
      for (const action of actions) expect([action, classifyAuditAction(action)?.category]).toEqual([action, category]);
    }
  });

  it('business, delivery and AI telemetry actions are not shipped; an unknown action is not shipped', () => {
    for (const action of [AuditAction.OFFER_SENT, AuditAction.STAFF_CLOCKED_IN, AuditAction.AI_TOOL_CALLED, AuditAction.EMAIL_DELIVERY_FAILED, 'not.an_action']) {
      expect(classifyAuditAction(action)).toBeNull();
    }
    expect(classifyAuditAction('__proto__')).toBeNull();
    expect(classifyAuditAction('constructor')).toBeNull();
  });

  it('every shipped action is a valid sink event type', () => {
    for (const action of shipped) expect(action).toMatch(/^[a-z][a-z0-9_]*(\.[a-z0-9_]+){1,5}$/);
  });
});
