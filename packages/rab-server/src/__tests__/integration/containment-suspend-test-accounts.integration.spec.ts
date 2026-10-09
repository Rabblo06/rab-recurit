import 'reflect-metadata';
import { UserStatus } from '@rab/shared';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { randomUUID } from 'node:crypto';

import { AppModule } from '../../app.module';
import { AuditService } from '../../engine/core-modules/audit/audit.service';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { RefreshTokenService } from '../../engine/core-modules/auth/token/services/refresh-token.service';
import { SecurityVersionService } from '../../engine/core-modules/auth/services/security-version.service';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { WorkspaceMembershipService } from '../../engine/core-modules/tenant/workspace-membership.service';
import {
  ContainmentRefusal,
  suspendContainmentTargets,
  verifyContainmentAfter,
  verifyContainmentTargets,
  VerifiedTarget,
} from '../../command/containment/suspend-test-accounts';
import { User } from '../../modules/identity/entities';
import { createAdminDataSource } from './helpers/admin-datasource';
import { generateFixturePassword } from './helpers/fixture-password';
import { TestIdentity, TestIdentityFactory } from './helpers/test-identities';

/**
 * Incident 2026-10-05 containment, proven on a DISPOSABLE database (a fresh migration chain). Targets and expectations are read
 * from the database exactly as the verifier reads them: every test-pattern organisation and every user in it.
 *
 * Covers: read-only verification, dry-run writes nothing, refusals before any write, execution through the existing primitives,
 * sessions made unusable, login refused, audit written, history preserved, and stop on an unexpected state change.
 */
const RUN = Boolean(process.env.DATABASE_URL);
// Test 4 (execute) suspends real accounts through the existing primitives — status transition,
// workspace membership suspend, refresh-token revocation, audit write, all per-user, over a real
// login/argon2id round trip to set up — comfortably past Jest's 5s default. Found live via a real
// timeout, not a hang: the other four tests in this file (dry-run, refusals) stay well under this.
jest.setTimeout(30_000);
(RUN ? describe : describe.skip)('incident containment: suspend test accounts', () => {
  let app: INestApplication;
  let owner: DataSource;
  let factory: TestIdentityFactory;
  let deps: {
    dataSource: DataSource;
    tenantContext: TenantContextService;
    membership: WorkspaceMembershipService;
    refreshTokens: RefreshTokenService;
    securityVersion: SecurityVersionService;
    audit: AuditService;
  };
  let a: { organisationId: string; manager: TestIdentity; staff: TestIdentity; rawUserId: string };

  /** The population as the containment command reads it: all test-pattern organisations, their users, and the active targets. */
  async function scopeNow() {
    const orgs: Array<{ id: string }> = await owner.query(`SELECT id FROM core.organisation WHERE slug ~ '^test-[0-9a-f-]{36}$'`);
    const ids = orgs.map((o) => o.id);
    const users: Array<{ id: string; organisation_id: string; status: string }> = await owner.query(
      `SELECT id, organisation_id, status FROM core."user" WHERE organisation_id = ANY($1::uuid[])`,
      [ids],
    );
    const targets = users.filter((u) => u.status === 'active').map((u) => ({ organisationId: u.organisation_id, userId: u.id }));
    return { targets, expected: { organisations: ids.length, users: users.length, activeUsers: targets.length } };
  }

  async function status(userId: string): Promise<string> {
    const [row] = await owner.query(`SELECT status FROM core."user" WHERE id = $1`, [userId]);
    return row.status as string;
  }

  async function counts() {
    const [o] = await owner.query(`SELECT count(*)::int AS n FROM core.organisation`);
    const [u] = await owner.query(`SELECT count(*)::int AS n FROM core."user"`);
    const [l] = await owner.query(`SELECT count(*)::int AS n FROM core.login_history`);
    return { organisations: o.n as number, users: u.n as number, loginHistory: l.n as number };
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    owner = createAdminDataSource();
    await owner.initialize();
    factory = new TestIdentityFactory({
      app,
      dataSource: moduleRef.get(DataSource),
      adminDataSource: owner,
      tenantContext: moduleRef.get(TenantContextService),
      passwordHashing: moduleRef.get(PasswordHashingService),
    });
    deps = {
      dataSource: owner,
      tenantContext: moduleRef.get(TenantContextService),
      membership: moduleRef.get(WorkspaceMembershipService),
      refreshTokens: moduleRef.get(RefreshTokenService),
      securityVersion: moduleRef.get(SecurityVersionService),
      audit: moduleRef.get(AuditService),
    };

    // Organisation A: a manager, a staff member, and a user with no profile. All ACTIVE.
    const org = await factory.createOrganisationWithManagers(1, { permissions: 'production', workspace: true, label: 'contain' });
    const manager = org.managers[0]!;
    const staff = await factory.createStaff(org.organisation, { owner: manager, label: 'contain-staff' });
    const hash = await new PasswordHashingService().hash(generateFixturePassword());
    const inserted = await owner.manager.insert(User, {
      organisationId: org.organisation.id,
      email: `raw-${randomUUID()}@example.test`,
      passwordHash: hash,
      firstName: 'Raw',
      lastName: 'Account',
      status: UserStatus.ACTIVE,
    });
    a = { organisationId: org.organisation.id, manager, staff, rawUserId: inserted.identifiers[0]!.id as string };
  });

  afterAll(async () => {
    await app?.close();
    await owner?.destroy();
  });

  it('1. dry-run writes nothing and reports every active target as dry-run', async () => {
    const scope = await scopeNow();
    const verified = await verifyContainmentTargets(owner, scope.targets, scope.expected);
    const outcomes: Array<{ result: string }> = [];
    await suspendContainmentTargets(deps, a.manager.userId!, verified, { execute: false, onOutcome: (o) => outcomes.push(o) });
    expect(outcomes.length).toBe(scope.targets.length);
    expect(outcomes.every((o) => o.result === 'dry-run')).toBe(true);
    expect(await status(a.manager.userId!)).toBe('active');
    expect(await status(a.rawUserId)).toBe('active');
  });

  it('2. a wrong frozen expectation refuses before any write', async () => {
    const scope = await scopeNow();
    await expect(verifyContainmentTargets(owner, scope.targets, { ...scope.expected, users: scope.expected.users + 1 })).rejects.toBeInstanceOf(
      ContainmentRefusal,
    );
    expect(await status(a.manager.userId!)).toBe('active');
  });

  it('3. a user in an organisation outside the test-pattern set is refused, and nothing is written', async () => {
    const realOrgId = randomUUID();
    await owner.query(`INSERT INTO core.organisation (id, name, slug) VALUES ($1, 'Customer X', $2)`, [realOrgId, `customer-x-${realOrgId}`]);
    const scope = await scopeNow();
    const withOutsider = [...scope.targets, { organisationId: realOrgId, userId: a.manager.userId! }];
    await expect(verifyContainmentTargets(owner, withOutsider, scope.expected)).rejects.toBeInstanceOf(ContainmentRefusal);
    expect(await status(a.manager.userId!)).toBe('active');
  });

  it('4. execute: deactivates every active target through the existing primitives, makes sessions unusable, refuses login, keeps history', async () => {
    const managerToken = await factory.login(a.manager);
    const staffToken = await factory.login(a.staff);
    const beforeMe = await request(app.getHttpServer()).get('/rest/v1/auth/me').set('Authorization', `Bearer ${managerToken}`);
    expect(beforeMe.status).toBe(200);
    const before = await counts();
    const scope = await scopeNow();

    const verified = await verifyContainmentTargets(owner, scope.targets, scope.expected);
    const outcomes: Array<{ result: string }> = [];
    await suspendContainmentTargets(deps, a.manager.userId!, verified, { execute: true, onOutcome: (o) => outcomes.push(o) });
    expect(outcomes.length).toBe(scope.targets.length);
    expect(outcomes.every((o) => o.result === 'suspended')).toBe(true);

    for (const t of scope.targets) expect(await status(t.userId)).toBe('suspended');
    const after = await verifyContainmentAfter(owner, scope.targets.map((t) => t.userId));
    expect(after).toEqual({ activeTargets: 0, liveFamilies: 0 });

    // Sessions: the per-request session check rejects tokens issued before containment.
    for (const token of [managerToken, staffToken]) {
      const me = await request(app.getHttpServer()).get('/rest/v1/auth/me').set('Authorization', `Bearer ${token}`);
      expect(me.status).toBe(401);
    }

    // Password login is refused for the suspended identities.
    for (const identity of [a.manager, a.staff]) {
      const res = await request(app.getHttpServer())
        .post('/rest/v1/auth/login')
        .send({ email: identity.email, password: identity.password, applicationTarget: identity.kind === 'staff' ? 'staff_app' : 'manager_web' });
      expect(res.status).not.toBe(200);
      expect(res.body.accessToken).toBeUndefined();
    }

    // Audit: one suspension row per target, carrying the containment reason.
    // audit_log is FORCE RLS (the owner is not exempt), so the count is read in the organisation's tenant context.
    const audit = await deps.tenantContext.runInTenantContext(
      { organisationId: a.organisationId, workspaceId: null, userId: a.manager.userId!, role: '' },
      (m) =>
        m.query(
          `SELECT count(*)::int AS n FROM core.audit_log WHERE action = $1 AND metadata->>'reason' = 'incident-2026-10-05-containment'`,
          ['user.suspended'],
        ),
    );
    expect(audit[0].n).toBe(scope.targets.length);

    // Preserved: no user or organisation deleted, and login history never shrinks. The refused login attempts above are
    // recorded as new history rows, which is correct: a refused attempt is evidence.
    const afterCounts = await counts();
    expect(afterCounts.users).toBe(before.users);
    expect(afterCounts.organisations).toBe(before.organisations);
    expect(afterCounts.loginHistory).toBeGreaterThanOrEqual(before.loginHistory);
  });

  it('5. stops at the first unexpected state change: the failure is recorded and no later user is written', async () => {
    const second = await factory.createOrganisationWithManagers(1, { permissions: 'production', workspace: true, label: 'stop' });
    const secondManager = second.managers[0]!;
    const secondStaff = await factory.createStaff(second.organisation, { owner: secondManager, label: 'stop-staff' });
    // A user that changed state after verification: suspended behind the verifier's back.
    await owner.query(`UPDATE core."user" SET status = 'suspended' WHERE id = $1`, [secondManager.userId]);
    // A third target that is still ACTIVE: it must be left untouched because the run stops at the manager above.
    const thirdInsert = await owner.manager.insert(User, {
      organisationId: second.organisation.id,
      email: `late-${randomUUID()}@example.test`,
      passwordHash: await new PasswordHashingService().hash(generateFixturePassword()),
      firstName: 'Late',
      lastName: 'Target',
      status: UserStatus.ACTIVE,
    });
    const lateUserId = thirdInsert.identifiers[0]!.id as string;
    const verified: VerifiedTarget[] = [
      { organisationId: second.organisation.id, userId: secondStaff.userId!, previousStatus: 'active' },
      { organisationId: second.organisation.id, userId: secondManager.userId!, previousStatus: 'active' },
      { organisationId: second.organisation.id, userId: lateUserId, previousStatus: 'active' },
    ];
    const outcomes: Array<{ userId: string; result: string }> = [];
    await expect(
      suspendContainmentTargets(deps, secondManager.userId!, verified, { execute: true, onOutcome: (o) => outcomes.push(o) }),
    ).rejects.toBeInstanceOf(ContainmentRefusal);
    expect(await status(secondStaff.userId!)).toBe('suspended');
    expect(outcomes.find((o) => o.userId === secondManager.userId)?.result).toBe('failed');
    // Stopped before the third target: the first user was written (before the stop), the third was never written.
    expect(await status(secondStaff.userId!)).toBe('suspended');
    expect(await status(lateUserId)).toBe('active');
  });
});
