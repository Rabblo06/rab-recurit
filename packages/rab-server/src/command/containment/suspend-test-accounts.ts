/**
 * Incident 2026-10-05 containment: deactivate the active accounts of the frozen, investigated test-pattern organisations.
 *
 * Uses the existing account-suspension primitives. It does NOT write users directly, and it does not invent a parallel auth
 * revocation system. Per user, in one transaction, the same sequence as ManagerService.setActive(ctx, id, false):
 *   User.status ACTIVE -> SUSPENDED   (assertTransition against USER_STATUS_TRANSITIONS)
 *   WorkspaceMembershipService.suspendForUser
 *   RefreshTokenService.revokeAllForUser
 *   AuditService.record ACCOUNT_SUSPENDED (reason: incident-2026-10-05-containment)
 * Nothing is deleted. Organisations, historical login rows, audit rows and business data are untouched.
 *
 * Safety:
 *   - Read-only verification FIRST. Every target must exist, belong to its organisation, sit in a test-pattern organisation,
 *     use an example.test address, and currently be ACTIVE. Totals must equal the frozen expectation, or nothing is written.
 *   - Dry-run is the default. Writes require execute = true.
 *   - An unexpected domain error stops the run. Nothing is bypassed with raw SQL.
 *   - Results contain user and organisation ids and outcomes only. No email, token or credential is recorded.
 *
 * Phase B (ops container): the cross-tenant READS are the frozen, named statements below (CONTAINMENT_READ_STATEMENTS). In
 * the one-off ops container they run on the verified elevated session (migration identity, `SET LOCAL ROLE
 * rab_secure_owner`, READ ONLY transaction — command/ops/elevated-ops-session.ts); organisation and user are
 * rab_secure_owner-owned and not FORCE'd, so only their owner sees every tenant's rows. A test may pass a plain DataSource
 * instead (dataSourceReadSession: same statements, READ ONLY transaction). The WRITES always go through the restricted
 * runtime login (crewflow_app) in each target's own tenant context.
 */
import { assertTransition, USER_STATUS_TRANSITIONS, UserStatus } from '@rab/shared';
import { DataSource, EntityManager } from 'typeorm';

import { AuditAction, AuditService } from '../../engine/core-modules/audit/audit.service';
import { RefreshTokenService } from '../../engine/core-modules/auth/token/services/refresh-token.service';
import { SecurityVersionService } from '../../engine/core-modules/auth/services/security-version.service';
import { AuthContext } from '../../engine/core-modules/tenant/auth-context.interface';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { WorkspaceMembershipService } from '../../engine/core-modules/tenant/workspace-membership.service';
import { User } from '../../modules/identity/entities';

export const CONTAINMENT_REASON = 'incident-2026-10-05-containment';
const TEST_PATTERN = '^test-[0-9a-f-]{36}$';
const FIXTURE_DOMAIN = '@example.test';

export interface ContainmentTarget {
  organisationId: string;
  userId: string;
}

export interface ContainmentExpectation {
  organisations: number;
  /** Every user in the frozen test-pattern organisations, all statuses. */
  users: number;
  /** Active users in those organisations: the population this run deactivates. */
  activeUsers: number;
}

export interface VerifiedTarget {
  organisationId: string;
  userId: string;
  previousStatus: string;
}

export interface ContainmentDeps {
  dataSource: DataSource;
  tenantContext: TenantContextService;
  membership: WorkspaceMembershipService;
  refreshTokens: RefreshTokenService;
  securityVersion: SecurityVersionService;
  audit: AuditService;
}

export interface ContainmentOutcome {
  userId: string;
  organisationId: string;
  result: 'suspended' | 'dry-run' | 'failed';
  reason?: string;
}

/** The frozen read statements (named; the elevated ops session runs names, never SQL text). */
export const CONTAINMENT_READ_STATEMENTS = Object.freeze({
  'containment.test-pattern-organisations': `SELECT id, slug FROM core.organisation WHERE slug ~ $1`,
  'containment.population-counts': `SELECT count(*)::int AS n, count(*) FILTER (WHERE status = 'active')::int AS active
         FROM core."user" WHERE organisation_id = ANY($1::uuid[])`,
  'containment.target-users': `SELECT id, organisation_id, status, email FROM core."user" WHERE id = ANY($1::uuid[])`,
  'containment.after-active-targets': `SELECT count(*)::int AS n FROM core."user" WHERE id = ANY($1::uuid[]) AND status = 'active'`,
  'containment.after-live-families': `SELECT count(DISTINCT family_id)::int AS n FROM core.refresh_token
        WHERE user_id = ANY($1::uuid[]) AND revoked_at IS NULL AND family_expires_at > now()`,
} as const);
export type ContainmentStatementName = keyof typeof CONTAINMENT_READ_STATEMENTS;

/** A READ ONLY transaction that runs named containment statements. */
export interface ContainmentReadSession {
  readOnly<T>(fn: (run: (name: ContainmentStatementName, params: unknown[]) => Promise<Array<Record<string, any>>>) => Promise<T>): Promise<T>;
}

/** Tests and non-ops callers: the same named statements on a plain DataSource, inside a READ ONLY transaction. */
export function dataSourceReadSession(dataSource: DataSource): ContainmentReadSession {
  return {
    readOnly: (fn) =>
      dataSource.transaction(async (m) => {
        await m.query('SET TRANSACTION READ ONLY');
        return fn((name, params) => m.query(CONTAINMENT_READ_STATEMENTS[name], params));
      }),
  };
}

function asReadSession(source: DataSource | ContainmentReadSession): ContainmentReadSession {
  return source instanceof DataSource ? dataSourceReadSession(source) : source;
}

export class ContainmentRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContainmentRefusal';
  }
}

/** Read-only verification. Throws ContainmentRefusal, and writes nothing, if the frozen set does not match exactly. */
export async function verifyContainmentTargets(
  source: DataSource | ContainmentReadSession,
  targets: ContainmentTarget[],
  expected: ContainmentExpectation,
): Promise<VerifiedTarget[]> {
  const uniqueUsers = new Set(targets.map((t) => t.userId));
  if (uniqueUsers.size !== targets.length) throw new ContainmentRefusal('the target list contains duplicate user ids');

  return asReadSession(source).readOnly(async (run) => {
    // The population is read from the database, not from the file: every test-pattern organisation and its users.
    const orgs = (await run('containment.test-pattern-organisations', [TEST_PATTERN])) as Array<{ id: string; slug: string }>;
    if (orgs.length !== expected.organisations) {
      throw new ContainmentRefusal(`test-pattern organisation count ${orgs.length} differs from the frozen expectation ${expected.organisations}`);
    }
    const orgIds = orgs.map((o) => o.id);
    const [counts] = await run('containment.population-counts', [orgIds]);
    if (counts.n !== expected.users) {
      throw new ContainmentRefusal(`user count ${counts.n} differs from the frozen expectation ${expected.users}`);
    }
    if (counts.active !== expected.activeUsers) {
      throw new ContainmentRefusal(`active user count ${counts.active} differs from the frozen expectation ${expected.activeUsers}`);
    }
    const orgSet = new Set(orgIds);
    for (const t of targets) {
      if (!orgSet.has(t.organisationId)) throw new ContainmentRefusal(`target organisation ${t.organisationId} is not in the test-pattern set`);
    }

    const rows = (await run('containment.target-users', [targets.map((t) => t.userId)])) as Array<{
      id: string;
      organisation_id: string;
      status: string;
      email: string;
    }>;
    const byId = new Map(rows.map((r) => [r.id, r]));
    const verified: VerifiedTarget[] = [];
    for (const target of targets) {
      const row = byId.get(target.userId);
      if (!row) throw new ContainmentRefusal(`target user ${target.userId} does not exist`);
      if (row.organisation_id !== target.organisationId) throw new ContainmentRefusal(`target user ${target.userId} is not in its frozen organisation`);
      if (!row.email.toLowerCase().endsWith(FIXTURE_DOMAIN)) throw new ContainmentRefusal(`target user ${target.userId} is not a fixture address`);
      // A non-active user is recorded with its status and left alone: this run deactivates only ACTIVE users.
      verified.push({ organisationId: target.organisationId, userId: target.userId, previousStatus: row.status });
    }
    // The file must cover every active user in scope, or the run would leave some of them untouched.
    const activeTargets = verified.filter((v) => v.previousStatus === 'active').length;
    if (activeTargets !== expected.activeUsers) {
      throw new ContainmentRefusal(`target file covers ${activeTargets} active users; the frozen population is ${expected.activeUsers}`);
    }
    return verified;
  });
}

/**
 * Deactivates every ACTIVE verified target, one transaction per user, through the existing primitives. Dry-run writes nothing.
 * Stops at the first unexpected error.
 */
export async function suspendContainmentTargets(
  deps: ContainmentDeps,
  actorUserId: string,
  verified: VerifiedTarget[],
  options: {
    execute: boolean;
    onOutcome: (o: ContainmentOutcome) => void;
    onProgress?: (done: number, total: number) => void;
    /** Extra audit metadata on every ACCOUNT_SUSPENDED row (the ops container's operational label). */
    auditMetadata?: Record<string, unknown>;
  },
): Promise<void> {
  const pending = verified.filter((v) => v.previousStatus === 'active');
  for (const v of verified) {
    if (v.previousStatus !== 'active') {
      options.onOutcome({ userId: v.userId, organisationId: v.organisationId, result: 'failed', reason: `skipped: already ${v.previousStatus}` });
    }
  }
  if (!options.execute) {
    for (const v of pending) options.onOutcome({ userId: v.userId, organisationId: v.organisationId, result: 'dry-run' });
    return;
  }

  let done = 0;
  for (const v of pending) {
    const ctx: AuthContext = { organisationId: v.organisationId, workspaceId: null, userId: actorUserId, role: '' };
    try {
      await deps.tenantContext.runInTenantContext(ctx, async (m: EntityManager) => {
        const user = await m.findOneByOrFail(User, { id: v.userId });
        if (user.status !== UserStatus.ACTIVE) throw new ContainmentRefusal(`user ${v.userId} changed status during the run (${user.status})`);
        assertTransition(USER_STATUS_TRANSITIONS, UserStatus.ACTIVE, UserStatus.SUSPENDED);
        await m.update(User, v.userId, { status: UserStatus.SUSPENDED });
        await deps.securityVersion.bumpUser(m, v.userId);
        await deps.membership.suspendForUser(m, v.userId);
        await deps.refreshTokens.revokeAllForUser(m, v.userId);
        await deps.audit.record(m, ctx, AuditAction.ACCOUNT_SUSPENDED, {
          targetUserId: v.userId,
          metadata: { ...(options.auditMetadata ?? {}), reason: CONTAINMENT_REASON },
        });
      });
      options.onOutcome({ userId: v.userId, organisationId: v.organisationId, result: 'suspended' });
    } catch (error) {
      const reason = error instanceof ContainmentRefusal ? error.message : `unexpected ${(error as Error).name}`;
      options.onOutcome({ userId: v.userId, organisationId: v.organisationId, result: 'failed', reason });
      // Stop on any failure: an unexpected domain error is never bypassed, and a refusal means the state changed under us.
      throw new ContainmentRefusal(`stopped at user ${v.userId}: ${reason}`);
    }
    done++;
    options.onProgress?.(done, pending.length);
  }
}

/** Post-run verification, read-only. */
export async function verifyContainmentAfter(
  source: DataSource | ContainmentReadSession,
  userIds: string[],
): Promise<{ activeTargets: number; liveFamilies: number }> {
  return asReadSession(source).readOnly(async (run) => {
    const [a] = await run('containment.after-active-targets', [userIds]);
    const [f] = await run('containment.after-live-families', [userIds]);
    return { activeTargets: a.n as number, liveFamilies: f.n as number };
  });
}
