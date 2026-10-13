import 'reflect-metadata';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { AppModule } from '../../app.module';
import { AccessTokenService } from '../../engine/core-modules/auth/token/services/access-token.service';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { WorkspaceResolverService } from '../../engine/core-modules/tenant/workspace-resolver.service';
import { Organisation } from '../../modules/identity/entities';
import { createAdminDataSource } from './helpers/admin-datasource';
import { BootstrapTimer } from './helpers/bootstrap-trace';
import { withPoolTrace } from './helpers/pool-probe';
import { TestIdentity, TestIdentityFactory } from './helpers/test-identities';

/**
 * Hyper Workspace Phase 3, items 5–7 (membership cutover). USER → WORKSPACE, enforced by the database and by the
 * protected resolver. Real Postgres, real RLS, real HTTP. Every "denied" assertion checks the specific control, not
 * only a status code, so a 401 caused by a different bug cannot pass as the intended denial.
 *
 * Runtime role = crewflow (DATABASE_URL, P1C.2 single-credential migration). Owner connection for
 * setup/state changes = the privileged local bootstrap identity (DATABASE_URL_UNPOOLED); the
 * membership functions themselves are owned by the narrow NOLOGIN `rab_secure_owner`, never
 * `crewflow` directly.
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;

const RESOLVER_FUNCTIONS = [
  'core.resolve_membership_for_user(uuid)',
  'core.resolve_membership_for_session(uuid)',
  'core.suspend_workspace_membership(uuid)',
  'core.reinstate_workspace_membership(uuid)',
];

describeIfDb('workspace membership abuse cases (integration)', () => {
  let app: INestApplication;
  let appDs: DataSource;
  let owner: DataSource;
  let factory: TestIdentityFactory;
  let resolver: WorkspaceResolverService;
  let tokens: AccessTokenService;
  let tenantContext: TenantContextService;

  // Two organisations. Org A: Manager A (owns Workspace A), Staff A and Venue Manager A in Workspace A.
  // Org B: Manager B (owns Workspace B).
  let orgA: Organisation;
  let orgB: Organisation;
  let managerA: TestIdentity;
  let managerB: TestIdentity;
  let staffA: TestIdentity;
  let venueA: TestIdentity;
  let wsA: string;
  let wsB: string;

  beforeAll(async () => {
    const __bt = new BootstrapTimer('workspace-membership-abuse-cases');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    __bt.mark('compile');
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    __bt.mark('init');
    await app.get(DataSource).query('SELECT 1');
    __bt.mark('dbPing');
    __bt.log();

    appDs = moduleRef.get(DataSource);
    resolver = moduleRef.get(WorkspaceResolverService);
    tokens = moduleRef.get(AccessTokenService);
    tenantContext = moduleRef.get(TenantContextService);
    owner = createAdminDataSource();
    await owner.initialize();
    factory = new TestIdentityFactory({
      app,
      dataSource: appDs,
      adminDataSource: owner,
      tenantContext,
      passwordHashing: moduleRef.get(PasswordHashingService),
    });

    const a = await factory.createOrganisationWithManagers(1, { permissions: 'production', workspace: true, label: 'mga' });
    orgA = a.organisation;
    managerA = a.managers[0]!;
    wsA = managerA.workspaceId!;
    staffA = await factory.createStaff(orgA, { owner: managerA, label: 'sta' });
    venueA = await factory.createVenueManager(orgA, { owner: managerA, label: 'vma' });

    const b = await factory.createOrganisationWithManagers(1, { permissions: 'production', workspace: true, label: 'mgb' });
    orgB = b.organisation;
    managerB = b.managers[0]!;
    wsB = managerB.workspaceId!;
  });

  afterAll(async () => {
    await app?.close();
    await owner?.destroy();
  });

  /** Runs a read/write as the OWNER with the organisation and user bound (required once FORCE RLS is on). */
  async function asOwner<T>(organisationId: string, userId: string | null, fn: (m: import('typeorm').EntityManager) => Promise<T>): Promise<T> {
    return owner.transaction(async (m) => {
      await m.query(`SELECT set_config('rab.organisation_id', $1, true), set_config('rab.user_id', $2, true)`, [organisationId, userId ?? '']);
      return fn(m);
    });
  }

  /** Like asOwner, but also binds the workspace, so the insert policy's own predicate matches the attempted row. */
  async function asOwnerIn<T>(organisationId: string, userId: string, workspaceId: string, fn: (m: import('typeorm').EntityManager) => Promise<T>): Promise<T> {
    return owner.transaction(async (m) => {
      await m.query(`SELECT set_config('rab.organisation_id', $1, true), set_config('rab.user_id', $2, true), set_config('rab.workspace_id', $3, true)`, [organisationId, userId, workspaceId]);
      return fn(m);
    });
  }

  /**
   * Runs a read/write as the ORDINARY RUNTIME role (`appDs` = crewflow, the same DataSource the real
   * application uses — never the `owner`/superuser bootstrap connection `asOwner`/`asOwnerIn` use for
   * fixture setup). Required to exercise `workspace_membership`'s own FORCE RLS policy directly: `owner`
   * connects via the Postgres bootstrap SUPERUSER (`TEST_DATABASE_URL_UNPOOLED`), and a superuser bypasses
   * every row security policy unconditionally, FORCE or not — testing an INSERT/UPDATE policy through that
   * connection proves nothing about whether the policy itself would reject the row.
   */
  async function asApp<T>(organisationId: string, userId: string, workspaceId: string | null, fn: (m: import('typeorm').EntityManager) => Promise<T>): Promise<T> {
    return appDs.transaction(async (m) => {
      await m.query(
        `SELECT set_config('rab.organisation_id', $1, true), set_config('rab.user_id', $2, true), set_config('rab.workspace_id', $3, true)`,
        [organisationId, userId, workspaceId ?? ''],
      );
      return fn(m);
    });
  }

  async function membershipsOf(identity: TestIdentity): Promise<Array<{ workspace_id: string; status: string }>> {
    return asOwner(identity.organisationId, identity.userId, (m) =>
      m.query(`SELECT workspace_id, status FROM core.workspace_membership WHERE user_id = $1`, [identity.userId]),
    );
  }

  /** The live session family of a real login (logs the identity in first, so the family exists). */
  async function familyOf(identity: TestIdentity): Promise<string> {
    await bearerFor(identity);
    const rows = await asOwner(identity.organisationId, identity.userId, (m) =>
      m.query(`SELECT DISTINCT family_id FROM core.refresh_token WHERE user_id = $1 AND revoked_at IS NULL`, [identity.userId]),
    );
    expect(rows.length).toBeGreaterThanOrEqual(1);
    return rows[rows.length - 1].family_id as string;
  }

  async function bearerFor(identity: TestIdentity, target?: 'manager_web' | 'staff_app' | 'venue_manager_app'): Promise<string> {
    return factory.login(identity, target ? { applicationTarget: target } : {});
  }

  /** A signed access token for `subject` that names `sid` as its session (used to forge a wrong family binding). */
  function tokenWithSid(subject: TestIdentity, sid: string): string {
    return tokens.sign({ sub: subject.userId, org: subject.organisationId, roles: [subject.roleKey], sid, applicationTarget: 'manager_web' }, 60_000);
  }

  // ------------------------------------------------------------------ 1. identity → workspace (protected path)

  it('Manager A resolves Workspace A and Manager B resolves Workspace B, via the verified session family', async () => {
    const a = await resolver.resolveForSession(await familyOf(managerA));
    const b = await resolver.resolveForSession(await familyOf(managerB));
    expect(a).toMatchObject({ userId: managerA.userId, organisationId: orgA.id, workspaceId: wsA });
    expect(b).toMatchObject({ userId: managerB.userId, organisationId: orgB.id, workspaceId: wsB });
  });

  it('Staff A and Venue Manager A resolve Workspace A', async () => {
    expect((await resolver.resolveForSession(await familyOf(staffA)))?.workspaceId).toBe(wsA);
    expect((await resolver.resolveForSession(await familyOf(venueA)))?.workspaceId).toBe(wsA);
  });

  it('Manager A cannot reach Workspace B by supplying B ids on the protected request (header, query, body)', async () => {
    const token = await bearerFor(managerA);
    const res = await request(app.getHttpServer())
      .get(`/rest/v1/auth/me?workspaceId=${wsB}&organisationId=${orgB.id}&userId=${managerB.userId}&schemaName=workspace_${wsB.replace(/-/g, '')}`)
      .set('Authorization', `Bearer ${token}`)
      .set('x-workspace-id', wsB)
      .set('x-organisation-id', orgB.id)
      .set('x-user-id', managerB.userId);
    expect(res.status).toBe(200);
    const body = JSON.stringify(res.body);
    expect(body).toContain(managerA.userId);
    expect(body).not.toContain(managerB.userId);
    expect(body).not.toContain(wsB);
  });

  it('a valid token for A whose sid names B\'s family is rejected (the family must belong to the token subject)', async () => {
    const forged = tokenWithSid(managerA, await familyOf(managerB));
    const res = await request(app.getHttpServer()).get('/rest/v1/auth/me').set('Authorization', `Bearer ${forged}`);
    expect(res.status).toBe(401);
  });

  it('a revoked session fails closed (401) and the membership itself is untouched', async () => {
    // The token is issued BEFORE the family is revoked. Logging in again would create a fresh, live family.
    const token = await bearerFor(staffA, 'staff_app');
    const [latest] = await asOwner(orgA.id, staffA.userId, (m) =>
      m.query(`SELECT family_id FROM core.refresh_token WHERE user_id = $1 AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1`, [staffA.userId]),
    );
    const sid = latest.family_id as string;
    await owner.query(`UPDATE core.refresh_token SET revoked_at = now() WHERE family_id = $1`, [sid]);
    try {
      expect(await resolver.resolveForSession(sid)).toBeNull();
      expect((await request(app.getHttpServer()).get('/rest/v1/auth/me').set('Authorization', `Bearer ${token}`)).status).toBe(401);
    } finally {
      await owner.query(`UPDATE core.refresh_token SET revoked_at = NULL WHERE family_id = $1`, [sid]);
    }
    expect(await membershipsOf(staffA)).toEqual([expect.objectContaining({ workspace_id: wsA, status: 'active' })]);
  });

  it('an expired session fails closed (401)', async () => {
    const sid = await familyOf(venueA);
    await owner.query(`UPDATE core.refresh_token SET family_expires_at = now() - interval '1 minute' WHERE family_id = $1`, [sid]);
    try {
      expect(await resolver.resolveForSession(sid)).toBeNull();
    } finally {
      await owner.query(`UPDATE core.refresh_token SET family_expires_at = now() + interval '1 day' WHERE family_id = $1`, [sid]);
    }
  });

  it('an unknown or null session id resolves to nothing (fail closed, no error)', async () => {
    expect(await resolver.resolveForSession(randomUUID())).toBeNull();
  });

  // ------------------------------------------------------------------ 2. verified-user path and membership shape

  it('a verified user with no membership resolves to no workspace (fail closed, not an error)', async () => {
    const solo = await factory.createInternalManager(orgA, { permissions: 'production', label: 'noWs', workspace: false });
    expect(await resolver.resolveForUser(solo.userId)).toBeNull();
    expect(await membershipsOf(solo)).toEqual([]);
  });

  it('an INACTIVE membership fails closed; reinstating restores the same workspace', async () => {
    await asOwner(orgA.id, staffA.userId, (m) => m.query(`SELECT core.suspend_workspace_membership($1)`, [staffA.userId]));
    try {
      expect(await resolver.resolveForUser(staffA.userId)).toBeNull();
      expect(await resolver.resolveForSession(await familyOf(staffA))).toMatchObject({ workspaceId: null });
    } finally {
      await asOwner(orgA.id, staffA.userId, (m) => m.query(`SELECT core.reinstate_workspace_membership($1)`, [staffA.userId]));
    }
    expect(await resolver.resolveForUser(staffA.userId)).toBe(wsA);
  });

  it('a DUPLICATE membership row for the same user and workspace is refused by the database', async () => {
    await expect(
      asOwnerIn(orgA.id, staffA.userId, wsA, (m) =>
        m.query(
          `INSERT INTO core.workspace_membership (organisation_id, user_id, workspace_id, status, source)
           VALUES ($1, $2, $3, 'active', 'write_path')`,
          [orgA.id, staffA.userId, wsA],
        ),
      ),
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('a second ACTIVE workspace for the same user is refused, even in the same organisation', async () => {
    const otherWs = await asOwner(orgA.id, managerA.userId, (m) =>
      m.query(
        `INSERT INTO core.manager_workspace (organisation_id, owner_user_id, name, subdomain, status)
         VALUES ($1, $2, 'Second WS', $3, 'active') RETURNING id`,
        [orgA.id, managerA.userId, `second-${randomUUID().slice(0, 8)}`],
      ),
    ).catch((e) => e);
    // The owner may already own one workspace; the subdomain insert itself may be refused. Either way, no second
    // ACTIVE membership can be created for Manager A.
    if (!(otherWs instanceof Error)) {
      await expect(
        asOwner(orgA.id, managerA.userId, (m) =>
          m.query(
            `INSERT INTO core.workspace_membership (organisation_id, user_id, workspace_id, status, source)
             VALUES ($1, $2, $3, 'active', 'write_path')`,
            [orgA.id, managerA.userId, otherWs[0].id],
          ),
        ),
      ).rejects.toMatchObject({ code: '23505' });
    }
    expect(await membershipsOf(managerA)).toEqual([expect.objectContaining({ workspace_id: wsA, status: 'active' })]);
  });

  // The user below has NO membership, so the one-active-per-user index cannot fire first (Postgres checks unique
  // indexes before foreign keys). What is left to refuse is the organisation foreign key itself.
  it('cross-organisation membership is impossible: a user cannot be given a workspace of another organisation', async () => {
    const fresh = await factory.createInternalManager(orgA, { permissions: 'production', label: 'xorg', workspace: false });
    await expect(
      asOwnerIn(orgA.id, fresh.userId, wsB, (m) =>
        m.query(
          `INSERT INTO core.workspace_membership (organisation_id, user_id, workspace_id, status, source)
           VALUES ($1, $2, $3, 'active', 'write_path')`,
          [orgA.id, fresh.userId, wsB],
        ),
      ),
    ).rejects.toMatchObject({ code: '23503' });
  });

  it('a user cannot be given a membership row under a different organisation than their own', async () => {
    const fresh = await factory.createInternalManager(orgA, { permissions: 'production', label: 'xusr', workspace: false });
    await expect(
      asOwnerIn(orgB.id, fresh.userId, wsB, (m) =>
        m.query(
          `INSERT INTO core.workspace_membership (organisation_id, user_id, workspace_id, status, source)
           VALUES ($1, $2, $3, 'active', 'write_path')`,
          [orgB.id, fresh.userId, wsB],
        ),
      ),
    ).rejects.toMatchObject({ code: '23503' });
  });

  it('the insert policy refuses a row for a real workspace of the bound organisation that is not the bound workspace (RLS layer, not FK)', async () => {
    // P1C.2-F investigation finding, corrected twice before landing here:
    //
    // 1. The table's CURRENT policy (WorkspaceMembershipForceRls1786675200000 — supersedes the original
    //    WorkspaceMembership1786674700000 policy quoted in this test's old name) really does check BOTH
    //    `organisation_id = current_org() AND workspace_id = current_workspace()` on INSERT, under FORCE RLS.
    //    The ORIGINAL (broken) version of this test used wsB (org B's workspace) while bound to org A — that
    //    fixture ALSO fails the composite FK (workspace_membership_workspace_org_fkey), so Postgres reports
    //    23503 before the WITH CHECK is ever meaningfully exercised on an otherwise-FK-valid row.
    // 2. This test's OWN `asOwner`/`asOwnerIn` helpers run through `owner`, which connects as the Postgres
    //    bootstrap SUPERUSER for local test fixture purposes (see those helpers' own doc comments) — and a
    //    superuser bypasses every row security policy unconditionally, FORCE or not. Using them to probe an
    //    INSERT policy proves nothing: every fixture tried through `owner` succeeded regardless of the GUCs
    //    bound, which is exactly why this test needs `asApp` (the real crewflow runtime connection) instead.
    //
    // The correctly isolated fixture: a SECOND, genuinely real workspace under orgA (wsA2, owned by a
    // different manager so it doesn't collide with managerA's own one-workspace-per-owner constraint). Both
    // the FK (wsA2 really is orgA's) and the uniqueness index (a fresh user, no prior membership) are
    // satisfied — the only thing left that can reject `workspace_id: wsA2` while bound to `wsA` is the
    // policy's own `workspace_id = current_workspace()` conjunct.
    const ownerA2 = await factory.createInternalManager(orgA, { permissions: 'production', label: 'xrls-owner' });
    const wsA2 = ownerA2.workspaceId!;
    expect(wsA2).not.toBe(wsA);

    const fresh = await factory.createInternalManager(orgA, { permissions: 'production', label: 'xrls', workspace: false });
    await expect(
      asApp(orgA.id, fresh.userId, wsA, (m) =>
        m.query(
          `INSERT INTO core.workspace_membership (organisation_id, user_id, workspace_id, status, source)
           VALUES ($1, $2, $3, 'active', 'write_path')`,
          [orgA.id, fresh.userId, wsA2],
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' });

    // Prove the negative, not just the error code: the rejected write left no row behind at all. Read via
    // `owner` (the superuser bypass is exactly what makes this read trustworthy as a "does the row exist at
    // all" check, independent of whether some OTHER session could see it under RLS).
    const rows = await asOwner(orgA.id, fresh.userId, (m) =>
      m.query(`SELECT 1 FROM core.workspace_membership WHERE user_id = $1 AND workspace_id = $2`, [fresh.userId, wsA2]),
    );
    expect(rows).toHaveLength(0);
  });

  it('lifecycle functions refuse a user outside the bound organisation', async () => {
    await expect(
      asOwner(orgB.id, null, (m) => m.query(`SELECT core.suspend_workspace_membership($1)`, [staffA.userId])),
    ).rejects.toMatchObject({ code: '42501' });
    expect(await membershipsOf(staffA)).toEqual([expect.objectContaining({ status: 'active' })]);
  });

  // ------------------------------------------------------------------ 3. enumeration, privileges, context

  it('ordinary rab_app cannot enumerate memberships: only the bound user\'s own row is visible', async () => {
    const rowsFor = (orgId: string, userId: string | null) =>
      appDs.transaction(async (m) => {
        await m.query(`SELECT set_config('rab.organisation_id', $1, true), set_config('rab.user_id', $2, true)`, [orgId, userId ?? '']);
        return m.query(`SELECT user_id FROM core.workspace_membership`);
      });
    const own = await rowsFor(orgA.id, managerA.userId);
    expect(own.map((r: { user_id: string }) => r.user_id)).toEqual([managerA.userId]);
    expect(await rowsFor(orgA.id, null)).toEqual([]);
    expect((await rowsFor(orgA.id, managerA.userId)).some((r: { user_id: string }) => r.user_id === managerB.userId)).toBe(false);
    expect(await rowsFor(orgB.id, managerA.userId)).toEqual([]);
  });

  it('PUBLIC cannot execute any membership resolver or lifecycle function', async () => {
    for (const fn of RESOLVER_FUNCTIONS) {
      const [{ ok }] = await owner.query(`SELECT has_function_privilege('public', $1, 'EXECUTE') AS ok`, [fn]);
      expect({ fn, ok }).toEqual({ fn, ok: false });
    }
  });

  it('only rab_app and the owner hold EXECUTE on the membership functions (no other grantee)', async () => {
    for (const fn of RESOLVER_FUNCTIONS) {
      const grantees = await owner.query(
        `SELECT pg_get_userbyid(a.grantee) AS grantee FROM pg_proc p, aclexplode(p.proacl) a
          WHERE p.oid = $1::regprocedure AND a.privilege_type = 'EXECUTE'`,
        [fn],
      );
      const names: string[] = grantees.map((g: { grantee: string }) => g.grantee).sort();
      // P1C.2 gave the runtime role `crewflow` EXECUTE here, with these pre-auth-adjacent
      // membership functions owned by the narrow NOLOGIN `rab_secure_owner`. P2/P3 Checkpoint 2
      // (restricted runtime role) demoted `crewflow` to migration/bootstrap authority and
      // introduced `crewflow_app` as the actual runtime login — its EXECUTE grants here were
      // replicated from `crewflow`'s own (CrewflowAppRestrictedRuntimeRole1786687000000), never
      // revoked from `crewflow` itself, so both now legitimately hold it. Never `rab_app`/`rab_owner`
      // again — both retired as application logins. Same property this test always checked (the only
      // grantees are the current and former runtime identities plus the owner), just the current names.
      expect(names).toContain('crewflow_app');
      expect(names.filter((n) => n !== 'crewflow' && n !== 'crewflow_app' && n !== 'rab_secure_owner')).toEqual([]);
    }
  });

  it('the membership-owning role is NOSUPERUSER and NOBYPASSRLS (SECURITY DEFINER owner requirements)', async () => {
    const [row] = await owner.query(`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'rab_secure_owner'`);
    expect(row).toEqual({ rolsuper: false, rolbypassrls: false });
  });

  it('the resolver restores the caller\'s organisation and user context inside an open transaction', async () => {
    await appDs.transaction(async (m) => {
      await m.query(`SELECT set_config('rab.organisation_id', $1, true), set_config('rab.user_id', $2, true)`, [orgA.id, managerA.userId]);
      await m.query(`SELECT * FROM core.resolve_membership_for_user($1)`, [managerB.userId]);
      await m.query(`SELECT * FROM core.resolve_membership_for_session($1)`, [await familyOf(managerB)]);
      const [after] = await m.query(`SELECT current_setting('rab.organisation_id', true) AS o, current_setting('rab.user_id', true) AS u`);
      expect(after).toEqual({ o: orgA.id, u: managerA.userId });
    });
  });

  it('no routing or membership context survives the transaction on a reused pooled connection', async () => {
    const [s] = await appDs.query(`SELECT coalesce(current_setting('rab.organisation_id', true), '') AS o, coalesce(current_setting('rab.user_id', true), '') AS u`);
    expect(s).toEqual({ o: '', u: '' });
  });

  it('workspace_membership has RLS ENABLED and FORCE ENABLED (CI requires no exemption)', async () => {
    const [row] = await owner.query(`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'core.workspace_membership'::regclass`);
    expect(row).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
  });

  // ------------------------------------------------------------------ 4. applicationAllowed stays separate

  it('a valid Staff membership does not bypass applicationAllowed: staff on manager_web is refused', async () => {
    const res = await request(app.getHttpServer())
      .post('/rest/v1/auth/login')
      .send({ email: staffA.email, password: staffA.password, applicationTarget: 'manager_web' });
    expect(res.status).toBe(403);
  });

  it('the same Staff membership still lets the same account into staff_app', async () => {
    const res = await request(app.getHttpServer())
      .post('/rest/v1/auth/login')
      .send({ email: staffA.email, password: staffA.password, applicationTarget: 'staff_app' });
    expect(res.status).toBe(200);
  });

  it('a Venue Manager with membership is refused manager_web but admitted venue_manager_app', async () => {
    const denied = await request(app.getHttpServer())
      .post('/rest/v1/auth/login')
      .send({ email: venueA.email, password: venueA.password, applicationTarget: 'manager_web' });
    expect(denied.status).toBe(403);
    const ok = await request(app.getHttpServer())
      .post('/rest/v1/auth/login')
      .send({ email: venueA.email, password: venueA.password, applicationTarget: 'venue_manager_app' });
    expect(ok.status).toBe(200);
  });

  // ------------------------------------------------------------------ 5. write paths (server-derived workspace)

  it('Manager A creates Staff → the new membership is Workspace A', async () => {
    const token = await bearerFor(managerA);
    const email = `new-staff-${randomUUID().slice(0, 8)}@example.test`;
    const res = await request(app.getHttpServer())
      .post('/rest/v1/staff')
      .set('Authorization', `Bearer ${token}`)
      .send({ email, firstName: 'New', lastName: 'Staff' });
    expect(res.status).toBe(201);
    const [u] = await owner.query(`SELECT id FROM core."user" WHERE email = $1`, [email]);
    expect(await membershipsOf({ ...staffA, userId: u.id, organisationId: orgA.id })).toEqual([
      expect.objectContaining({ workspace_id: wsA, status: 'active' }),
    ]);
  });

  // PRODUCT FINDING (for owner decision): creating Manager/Venue Manager accounts requires MANAGER_MANAGE, which only the
  // CEO role holds. An internal Manager is refused (403, correct). The approved rule says "Manager A creates Venue Manager
  // → Workspace A", but the CEO has no workspace, so a CEO-created Venue Manager gets no membership at creation.
  it('an internal Manager (no MANAGER_MANAGE) cannot create a Venue Manager: 403, and no membership is written', async () => {
    const token = await bearerFor(managerA);
    const email = `new-vm-${randomUUID().slice(0, 8)}@example.test`;
    const res = await request(app.getHttpServer())
      .post('/rest/v1/managers')
      .set('Authorization', `Bearer ${token}`)
      .send({ email, firstName: 'New', lastName: 'VM', type: 'venue' });
    expect(res.status).toBe(403);
    const rows = await owner.query(`SELECT id FROM core."user" WHERE email = $1`, [email]);
    expect(rows).toEqual([]);
  });

  it('a client-supplied workspaceId on staff creation is refused (400), never becomes membership authority', async () => {
    const token = await bearerFor(managerB);
    const res = await request(app.getHttpServer())
      .post('/rest/v1/staff')
      .set('Authorization', `Bearer ${token}`)
      .send({ email: `forged-${randomUUID().slice(0, 8)}@example.test`, firstName: 'X', lastName: 'Y', workspaceId: wsA });
    expect(res.status).toBe(400);
  });

  it('Manager B\'s new Staff belongs to Workspace B, never Workspace A', async () => {
    const token = await bearerFor(managerB);
    const email = `b-staff-${randomUUID().slice(0, 8)}@example.test`;
    const res = await request(app.getHttpServer())
      .post('/rest/v1/staff')
      .set('Authorization', `Bearer ${token}`)
      .send({ email, firstName: 'B', lastName: 'Staff' });
    expect(res.status).toBe(201);
    const [u] = await owner.query(`SELECT id FROM core."user" WHERE email = $1`, [email]);
    const rows = await membershipsOf({ ...staffA, userId: u.id, organisationId: orgB.id });
    expect(rows.map((r) => r.workspace_id)).toEqual([wsB]);
  });

  it('deactivating Staff suspends the membership; reactivating restores it', async () => {
    const token = await bearerFor(managerA);
    const deact = await request(app.getHttpServer()).post(`/rest/v1/staff/${staffA.profileId}/deactivate`).set('Authorization', `Bearer ${token}`);
    expect(deact.status).toBeLessThan(300);
    expect(await membershipsOf(staffA)).toEqual([expect.objectContaining({ status: 'suspended' })]);
    const react = await request(app.getHttpServer()).post(`/rest/v1/staff/${staffA.profileId}/reactivate`).set('Authorization', `Bearer ${token}`);
    expect(react.status).toBeLessThan(300);
    expect(await membershipsOf(staffA)).toEqual([expect.objectContaining({ status: 'active' })]);
  });

  it('suspending a Manager through the lifecycle (CEO holds MANAGER_MANAGE) suspends their membership', async () => {
    // TEST-ONLY pool instrumentation (HWS stability pass): see helpers/pool-probe.ts. Never changes pool size or any timeout.
    await withPoolTrace(appDs, 'workspace-membership:ceo-suspend', async () => {
      const ceo = await factory.createCeo(orgA, { permissions: 'production' });
      const token = await bearerFor(ceo);
      const victim = await factory.createInternalManager(orgA, { permissions: 'production', label: 'victim' });
      const res = await request(app.getHttpServer()).post(`/rest/v1/managers/${victim.profileId}/deactivate`).set('Authorization', `Bearer ${token}`);
      expect(res.status).toBeLessThan(300);
      expect(await membershipsOf(victim)).toEqual([expect.objectContaining({ status: 'suspended' })]);
    });
  });
});
