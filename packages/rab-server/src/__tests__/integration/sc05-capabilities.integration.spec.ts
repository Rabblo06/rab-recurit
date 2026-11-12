import 'reflect-metadata';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PermissionFlag, PermissionFlagType } from '@rab/shared';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { AppModule } from '../../app.module';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { PermissionsService } from '../../engine/core-modules/permissions/permissions.service';
import { AuthContext } from '../../engine/core-modules/tenant/auth-context.interface';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { RequestCompletePayload, subscribeToRequestMetrics } from '../../engine/observability/request-context';
import { createAdminDataSource } from './helpers/admin-datasource';
import { TestIdentity, TestIdentityFactory } from './helpers/test-identities';

/**
 * SC-05 (Phase X Stage 0, S0-C-caches.md): `GET /auth/capabilities` ran one `userHasPermission` per flag, i.e. 18
 * concurrent tenant transactions (BEGIN, RESET ROLE, GUCs, search_path, 2 SELECTs, COMMIT each) per call, enough to occupy
 * the whole 9-connection API pool. It now answers from the request's already-resolved permission set (the set every
 * PermissionGuard of the same request authorises from): zero extra transactions; under Admin Inspect, the TARGET's set in
 * exactly one transaction. Real PostgreSQL (FORCE RLS), real HTTP.
 *
 * Parity: for every identity shape (role grants, few grants, override grant, override revoke, venue manager, platform
 * admin, inspected target) the response equals one `userHasPermission` per flag, the old implementation's exact semantics,
 * and `effectivePermissionsTx` equals per-flag `userHasPermissionTx` for all 46 flags.
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;

const CAPABILITY_FLAGS: readonly PermissionFlagType[] = [
  PermissionFlag.STAFF_VIEW, PermissionFlag.SCHEDULE_VIEW, PermissionFlag.VENUE_VIEW, PermissionFlag.OFFER_SEND,
  PermissionFlag.REPORT_VIEW, PermissionFlag.STAFFING_REQUEST_CREATE, PermissionFlag.ATTENDANCE_VIEW, PermissionFlag.VENUE_MANAGER_CREATE,
  PermissionFlag.REPORT_EXPORT, PermissionFlag.ATTENDANCE_EDIT, PermissionFlag.REVIEW_CREATE, PermissionFlag.STAFF_CREATE,
  PermissionFlag.STAFF_DEACTIVATE, PermissionFlag.PAYROLL_VIEW, PermissionFlag.PAYROLL_APPROVE, PermissionFlag.PAYROLL_CALCULATE,
  PermissionFlag.PAYROLL_MARK_PAID, PermissionFlag.MANAGER_MANAGE,
];
const ALL_FLAGS = Object.values(PermissionFlag) as PermissionFlagType[];

describeIfDb('SC-05 GET /auth/capabilities answers from the resolved permission set (integration)', () => {
  jest.setTimeout(180_000);

  let app: INestApplication;
  let owner: DataSource;
  let factory: TestIdentityFactory;
  let tenantContext: TenantContextService;
  let permissions: PermissionsService;
  let admin: TestIdentity;
  let manager: TestIdentity;
  let staff: TestIdentity;
  let venueManager: TestIdentity;
  let overridden: TestIdentity;
  let organisationId: string;
  const tokens = new Map<string, string>();

  const http = () => request(app.getHttpServer());
  const tokenOf = async (identity: TestIdentity) => {
    if (!tokens.has(identity.userId)) tokens.set(identity.userId, await factory.login(identity));
    return tokens.get(identity.userId)!;
  };
  const ctxOf = (identity: TestIdentity): AuthContext => ({ organisationId: identity.organisationId, workspaceId: identity.workspaceId, userId: identity.userId, role: '' });
  /** The previous implementation, verbatim: one userHasPermission (one tenant transaction) per flag. */
  const perFlag = async (identity: TestIdentity, flags: readonly PermissionFlagType[] = CAPABILITY_FLAGS) => {
    const entries: Array<[string, boolean]> = [];
    for (const flag of flags) entries.push([flag, await permissions.userHasPermission(ctxOf(identity), flag)]);
    return Object.fromEntries(entries);
  };
  const capabilities = async (identity: TestIdentity, headers: Record<string, string> = {}) => {
    const res = await http().get('/rest/v1/auth/capabilities').set({ Authorization: `Bearer ${await tokenOf(identity)}`, ...headers });
    expect(res.status).toBe(200);
    return res.body as Record<string, boolean>;
  };
  const setOverride = (userId: string, key: string, effect: 'grant' | 'revoke') =>
    owner.query(
      `INSERT INTO core.user_permission_override (user_id, permission_id, organisation_id, effect)
       SELECT $1, id, $2, $4 FROM core.permission WHERE key = $3
       ON CONFLICT (user_id, permission_id) DO UPDATE SET effect = EXCLUDED.effect`,
      [userId, organisationId, key, effect],
    );
  const clearOverride = (userId: string, key: string) =>
    owner.query(`DELETE FROM core.user_permission_override WHERE user_id = $1 AND permission_id = (SELECT id FROM core.permission WHERE key = $2)`, [userId, key]);
  /** Per-request metrics (transactions, SQL statements) of the next request to `route`. */
  const measure = async (route: string, run: () => Promise<unknown>): Promise<RequestCompletePayload> => {
    const seen: RequestCompletePayload[] = [];
    const stop = subscribeToRequestMetrics((p) => {
      if (p.route === route) seen.push(p);
    });
    try {
      await run();
      for (let i = 0; i < 50 && seen.length === 0; i++) await new Promise((r) => setTimeout(r, 10)); // 'finish' fires after the body
    } finally {
      stop();
    }
    expect(seen).toHaveLength(1);
    return seen[0]!;
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    owner = createAdminDataSource();
    await owner.initialize();
    tenantContext = moduleRef.get(TenantContextService);
    permissions = moduleRef.get(PermissionsService);
    factory = new TestIdentityFactory({ app, dataSource: moduleRef.get(DataSource), adminDataSource: owner, tenantContext, passwordHashing: moduleRef.get(PasswordHashingService) });

    const seeded = await factory.createOrganisationWithManagers(3, { permissions: 'production', firstIsPlatformAdmin: true, workspace: true, label: 'sc05' });
    [admin, manager, overridden] = seeded.managers as [TestIdentity, TestIdentity, TestIdentity];
    organisationId = seeded.organisation.id;
    staff = await factory.createStaff(seeded.organisation, { owner: manager, label: 'sc05-staff' });
    venueManager = await factory.createVenueManager(seeded.organisation, { owner: manager, label: 'sc05-vm' });
    // Overrides beat roles in both directions (no override writer exists in src/; operator SQL is the realistic path).
    await setOverride(overridden.userId, PermissionFlag.STAFF_VIEW, 'revoke');
    await setOverride(overridden.userId, PermissionFlag.MANAGER_MANAGE, 'grant');
    await setOverride(staff.userId, PermissionFlag.PAYROLL_VIEW, 'grant');
  });

  afterAll(async () => {
    await owner?.destroy();
    await app?.close();
  });

  it('every identity shape: the response is identical to one userHasPermission per flag (same 18 keys, same booleans)', async () => {
    for (const identity of [admin, manager, staff, venueManager, overridden]) {
      const body = await capabilities(identity);
      expect(Object.keys(body)).toEqual([...CAPABILITY_FLAGS]);
      expect(body).toEqual(await perFlag(identity));
    }
    // The overrides really are in effect (the parity above is not vacuous).
    const o = await capabilities(overridden);
    expect(o[PermissionFlag.STAFF_VIEW]).toBe(false);
    expect(o[PermissionFlag.MANAGER_MANAGE]).toBe(true);
    expect((await capabilities(staff))[PermissionFlag.PAYROLL_VIEW]).toBe(true);
  });

  it('effectivePermissionsTx equals per-flag userHasPermissionTx for all 46 flags, for every identity shape', async () => {
    expect(ALL_FLAGS).toHaveLength(46);
    for (const identity of [admin, manager, staff, venueManager, overridden]) {
      const ctx = ctxOf(identity);
      const [set, flags] = await tenantContext.runInTenantContext(ctx, async (m) => {
        const effective = await permissions.effectivePermissionsTx(m, ctx);
        const one: Record<string, boolean> = {};
        for (const flag of ALL_FLAGS) one[flag] = await permissions.userHasPermissionTx(m, ctx, flag);
        return [effective, one] as const;
      });
      expect(Object.fromEntries(ALL_FLAGS.map((f) => [f, set.has(f)]))).toEqual(flags);
    }
  });

  it('costs zero extra transactions: only the guard snapshot transaction runs (was 1 + 18)', async () => {
    const tx = jest.spyOn(tenantContext, 'runInTenantContext');
    const perFlagSpy = jest.spyOn(permissions, 'userHasPermission');
    try {
      await capabilities(manager); // warm (login and first request)
      tx.mockClear();
      perFlagSpy.mockClear();
      const metrics = await measure('/rest/v1/auth/capabilities', () => capabilities(manager));
      // eslint-disable-next-line no-console
      console.log(`SC-05 capabilities metrics (manager): transactions=${metrics.transactionCount} sql=${metrics.sqlCount} tenantTx=${tx.mock.calls.length} perFlag=${perFlagSpy.mock.calls.length}`);
      expect(perFlagSpy).not.toHaveBeenCalled();
      expect(tx).not.toHaveBeenCalled();
      expect(metrics.transactionCount).toBe(1); // the JwtAuthGuard security snapshot, nothing else
    } finally {
      tx.mockRestore();
      perFlagSpy.mockRestore();
    }
  });

  it('a grant or revoke takes effect on the very next request (nothing is cached across requests)', async () => {
    expect((await capabilities(manager))[PermissionFlag.STAFF_VIEW]).toBe(true);
    await setOverride(manager.userId, PermissionFlag.STAFF_VIEW, 'revoke');
    try {
      expect((await capabilities(manager))[PermissionFlag.STAFF_VIEW]).toBe(false);
      // ...and the hint agrees with the route guard that actually enforces it.
      expect((await http().get('/rest/v1/staff').set({ Authorization: `Bearer ${await tokenOf(manager)}` })).status).toBe(403);
    } finally {
      await clearOverride(manager.userId, PermissionFlag.STAFF_VIEW);
    }
    expect((await capabilities(manager))[PermissionFlag.STAFF_VIEW]).toBe(true);
  });

  it('a missing permission is a false hint, never a 403/404 (the endpoint has no route permission of its own)', async () => {
    const body = await capabilities(staff);
    expect(Object.values(body).some((v) => v === false)).toBe(true);
  });

  it('unauthenticated: 401, no hints', async () => {
    const res = await http().get('/rest/v1/auth/capabilities');
    expect(res.status).toBe(401);
    expect(res.body).not.toHaveProperty(PermissionFlag.STAFF_VIEW);
  });

  describe('Admin Inspect', () => {
    let sessionId: string;

    beforeAll(async () => {
      const res = await http().post(`/rest/v1/admin/inspect/${staff.userId}`).set({ Authorization: `Bearer ${await tokenOf(admin)}` });
      expect(res.status).toBe(201);
      sessionId = res.body.sessionId as string;
    });

    afterAll(async () => {
      await http().post('/rest/v1/admin/inspect/end').set({ Authorization: `Bearer ${await tokenOf(admin)}` });
    });

    it('answers with the INSPECTED target set (never the admin grants), in exactly one transaction', async () => {
      const adminOwn = await capabilities(admin);
      const tx = jest.spyOn(tenantContext, 'runInTenantContext');
      const effectiveSpy = jest.spyOn(permissions, 'effectivePermissionsTx');
      const perFlagSpy = jest.spyOn(permissions, 'userHasPermission');
      try {
        const body = await capabilities(admin, { 'X-Inspect-Session-Id': sessionId });
        const inspectedTx = tx.mock.calls.filter(([ctx]) => (ctx as AuthContext).inspectedBy === admin.userId).length;
        // eslint-disable-next-line no-console
        console.log(`SC-05 capabilities under Admin Inspect: inspected-identity tenant transactions=${inspectedTx} (MustResetPasswordGuard's own inspect lookup + this endpoint)`);
        // The endpoint: ONE effective-set query for the target, no per-flag check. (MustResetPasswordGuard adds its own,
        // pre-existing inspect-mode transaction: 2 in total, previously 1 + 18.)
        expect(effectiveSpy).toHaveBeenCalledTimes(1);
        expect((effectiveSpy.mock.calls[0]![1] as AuthContext).userId).toBe(staff.userId);
        expect(perFlagSpy).not.toHaveBeenCalled();
        expect(inspectedTx).toBe(2);
        expect(body).toEqual(await perFlag(staff));
        expect(body).not.toEqual(adminOwn);
      } finally {
        tx.mockRestore();
        effectiveSpy.mockRestore();
        perFlagSpy.mockRestore();
      }
    });

    it('a non-admin presenting someone else inspect header gets only their own hints (no disclosure)', async () => {
      const body = await capabilities(manager, { 'X-Inspect-Session-Id': sessionId });
      expect(body).toEqual(await perFlag(manager));
      expect(body).not.toEqual(await perFlag(staff));
    });
  });
});
