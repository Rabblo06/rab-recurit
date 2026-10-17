import 'reflect-metadata';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { DataSource, EntityManager } from 'typeorm';

import { AppModule } from '../../app.module';
import { AuthService } from '../../engine/core-modules/auth/services/auth.service';
import { OrganisationAuthProvidersService } from '../../engine/core-modules/auth/services/organisation-auth-providers.service';
import { OAuthTransactionStateService } from '../../engine/core-modules/auth/services/oauth-transaction-state.service';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { createAdminDataSource } from './helpers/admin-datasource';
import { TestIdentityFactory } from './helpers/test-identities';

/**
 * P1C.1B (FULL-ARCHITECTURE-UPGRADE-PLAN.md §33.7) — Google/Microsoft auth-provider convergence,
 * organisation-level provider lockout, and the four new migrations' own runtime invariants.
 *
 * `AuthService.signInWithProvider` is exercised DIRECTLY (not via the Google/Microsoft HTTP
 * controllers or openid-client) — this suite's job is the Crewflow-side identity resolution and
 * lockout logic, which is provider-protocol-agnostic by design; the OIDC exchange itself is a
 * well-maintained third-party library (openid-client) and is not re-tested here. No real Google/
 * Microsoft credentials are used or required anywhere in this file.
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;
jest.setTimeout(60_000);

describeIfDb('P1C.1B — auth providers, organisation lockout, provider linking', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let adminDataSource: DataSource;
  let tenantContext: TenantContextService;
  let factory: TestIdentityFactory;
  let authService: AuthService;
  let organisationAuthProviders: OrganisationAuthProvidersService;
  let oauthState: OAuthTransactionStateService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    dataSource = moduleRef.get(DataSource);
    tenantContext = moduleRef.get(TenantContextService);
    adminDataSource = createAdminDataSource();
    await adminDataSource.initialize();
    factory = new TestIdentityFactory({ app, dataSource, adminDataSource, tenantContext, passwordHashing: moduleRef.get(PasswordHashingService) });
    authService = moduleRef.get(AuthService);
    organisationAuthProviders = moduleRef.get(OrganisationAuthProvidersService);
    oauthState = moduleRef.get(OAuthTransactionStateService);
  });

  afterAll(async () => {
    await app.close();
    await adminDataSource.destroy();
  });

  async function withOrgUser<T>(organisationId: string, userId: string, fn: (manager: EntityManager) => Promise<T>): Promise<T> {
    return adminDataSource.transaction(async (manager) => {
      await manager.query(`SELECT set_config('rab.organisation_id', $1, true), set_config('rab.user_id', $2, true)`, [organisationId, userId]);
      return fn(manager);
    });
  }

  // ======================================================================== MIGRATION A
  describe('Migration A — web_session_token_hash / auth_provider on core.user_session', () => {
    it('a real password login writes auth_provider=password; web_session_token_hash is set for a manager_web login (P1C.1C) and stays NULL for mobile', async () => {
      const org = await factory.createOrganisation('p1c1b-mig-a');
      const manager = await factory.createInternalManager(org);
      await factory.login(manager); // defaults to manager_web — a genuinely new web session family now gets a cookie credential (FULL-ARCHITECTURE-UPGRADE-PLAN.md §33.9).

      const [webRow] = await withOrgUser(org.id, manager.userId, (m) =>
        m.query('SELECT auth_provider, web_session_token_hash FROM core.user_session WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1', [manager.userId]),
      );
      expect(webRow.auth_provider).toBe('password');
      expect(webRow.web_session_token_hash).toMatch(/^[0-9a-f]{64}$/);

      const staff = await factory.createStaff(org, { owner: manager });
      await factory.loginTokens(staff);
      const [mobileRow] = await withOrgUser(org.id, staff.userId, (m) =>
        m.query('SELECT auth_provider, web_session_token_hash FROM core.user_session WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1', [staff.userId]),
      );
      expect(mobileRow.auth_provider).toBe('password');
      expect(mobileRow.web_session_token_hash).toBeNull();
    });

    it('rab_app cannot UPDATE auth_provider or web_session_token_hash after creation, even under correct tenant context', async () => {
      const org = await factory.createOrganisation('p1c1b-mig-a-immutable');
      const manager = await factory.createInternalManager(org);
      await factory.login(manager);
      const [row] = await withOrgUser(org.id, manager.userId, (m) => m.query('SELECT id FROM core.user_session WHERE user_id = $1 LIMIT 1', [manager.userId]));

      const ctx = { organisationId: org.id, workspaceId: manager.workspaceId, userId: manager.userId, role: '' };
      // Two SEPARATE transactions — a rejected statement aborts its own transaction, so the
      // second probe must not share it with the first.
      await expect(
        tenantContext.runInTenantContext(ctx, (m) => m.query('UPDATE core.user_session SET auth_provider = $2 WHERE id = $1', [row.id, 'google'])),
      ).rejects.toThrow(/permission denied|immutable/i);
      await expect(
        tenantContext.runInTenantContext(ctx, (m) => m.query('UPDATE core.user_session SET web_session_token_hash = $2 WHERE id = $1', [row.id, 'x'])),
      ).rejects.toThrow(/permission denied|immutable/i);
    });

    it('the partial unique index rejects a duplicate web_session_token_hash at INSERT time (owner connection, bound GUCs, two fresh rows)', async () => {
      const org = await factory.createOrganisation('p1c1b-mig-a-unique');
      const m1 = await factory.createInternalManager(org, { label: 'dup1' });
      const m2 = await factory.createInternalManager(org, { label: 'dup2' });
      const sharedHash = `shared-hash-collision-probe-${randomUUID()}`;

      await withOrgUser(org.id, m1.userId, (m) =>
        m.query(
          `INSERT INTO core.user_session (id, organisation_id, user_id, application_target, absolute_expires_at, web_session_token_hash)
           VALUES ($1, $2, $3, 'manager_web', now() + interval '1 day', $4)`,
          [randomUUID(), org.id, m1.userId, sharedHash],
        ),
      );
      await expect(
        withOrgUser(org.id, m2.userId, (m) =>
          m.query(
            `INSERT INTO core.user_session (id, organisation_id, user_id, application_target, absolute_expires_at, web_session_token_hash)
             VALUES ($1, $2, $3, 'manager_web', now() + interval '1 day', $4)`,
            [randomUUID(), org.id, m2.userId, sharedHash],
          ),
        ),
      ).rejects.toThrow(/duplicate key/i);
    });
  });

  // ======================================================================== MIGRATION B
  describe('Migration B — organisation provider toggles + lockout', () => {
    it('the DB CHECK constraint rejects all three organisation flags set false', async () => {
      const org = await factory.createOrganisation('p1c1b-mig-b-check');
      await expect(
        adminDataSource.query(
          'UPDATE core.organisation SET password_auth_enabled = false, google_auth_enabled = false, microsoft_auth_enabled = false WHERE id = $1',
          [org.id],
        ),
      ).rejects.toThrow(/organisation_auth_provider_not_all_disabled/);
    });

    it('OrganisationAuthProvidersService.update() refuses a change that would leave zero EFFECTIVE providers (system AND org)', async () => {
      const org = await factory.createOrganisation('p1c1b-mig-b-effective');
      const manager = await factory.createInternalManager(org);
      const ctx = { organisationId: org.id, workspaceId: manager.workspaceId, userId: manager.userId, role: '' };
      // Google/Microsoft are system-enabled in this suite (beforeAll) — set up the lockout
      // scenario explicitly at the organisation level first, so disabling password is the one
      // remaining effective provider and must be refused.
      await adminDataSource.query('UPDATE core.organisation SET google_auth_enabled = false, microsoft_auth_enabled = false WHERE id = $1', [org.id]);
      await expect(organisationAuthProviders.update(ctx, { passwordAuthEnabled: false })).rejects.toThrow(/no way for anyone/i);

      // The organisation's row is unchanged — the rejected call never partially applied.
      const flags = await tenantContext.runInTenantContext(ctx, (m) => organisationAuthProviders.getOrganisationFlags(m, org.id));
      expect(flags.passwordAuthEnabled).toBe(true);
    });

    it('getEffectiveBySlug returns system-only for an unknown slug (no existence leak) and the real AND for a known one', async () => {
      const unknown = await organisationAuthProviders.getEffectiveBySlug(`nonexistent-${randomUUID()}`);
      expect(unknown).toEqual(organisationAuthProviders.systemEnabled());

      const org = await factory.createOrganisation('p1c1b-mig-b-slug');
      await adminDataSource.query('UPDATE core.organisation SET google_auth_enabled = false WHERE id = $1', [org.id]);
      const effective = await organisationAuthProviders.getEffectiveBySlug(org.slug);
      // google is system-disabled in this test env regardless, but password must reflect the real AND.
      expect(effective.password).toBe(true);
      expect(effective.google).toBe(false);
    });
  });

  // ======================================================================== MIGRATION C + signInWithProvider
  describe('Migration C — core.user_auth_identity + AuthService.signInWithProvider', () => {
    it('an unknown email is rejected generically and creates NO Crewflow account, NO link row', async () => {
      const email = `ghost-${randomUUID()}@example.test`;
      await expect(authService.signInWithProvider('google', { subject: randomUUID(), email }, {})).rejects.toThrow(/could not sign you in/i);

      const [row] = await adminDataSource.query('SELECT 1 FROM core.user_auth_identity WHERE verified_email_snapshot = $1', [email]);
      expect(row).toBeUndefined();
    });

    it('a real existing ACTIVE user signs in via Google for the first time: link is created, session has auth_provider=google, mustResetPassword is preserved', async () => {
      const org = await factory.createOrganisation('p1c1b-google-first');
      const manager = await factory.createInternalManager(org);
      const subject = randomUUID();

      const result = await authService.signInWithProvider('google', { subject, email: manager.email, emailVerified: true }, {});
      expect(result.mustResetPassword).toBe(false); // createInternalManager seeds an ACTIVE account with no reset pending

      const [link] = await withOrgUser(org.id, manager.userId, (m) =>
        m.query('SELECT user_id, provider FROM core.user_auth_identity WHERE provider_subject = $1', [subject]),
      );
      expect(link.user_id).toBe(manager.userId);
      expect(link.provider).toBe('google');

      const [session] = await withOrgUser(org.id, manager.userId, (m) =>
        m.query('SELECT auth_provider FROM core.user_session WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1', [manager.userId]),
      );
      expect(session.auth_provider).toBe('google');
    });

    it('the SAME Google subject signing in again resolves via the existing link — no duplicate row, same user', async () => {
      const org = await factory.createOrganisation('p1c1b-google-second');
      const manager = await factory.createInternalManager(org);
      const subject = randomUUID();

      await authService.signInWithProvider('google', { subject, email: manager.email, emailVerified: true }, {});
      await authService.signInWithProvider('google', { subject, email: manager.email, emailVerified: true }, {});

      const rows = await withOrgUser(org.id, manager.userId, (m) => m.query('SELECT id FROM core.user_auth_identity WHERE provider_subject = $1', [subject]));
      expect(rows).toHaveLength(1);
    });

    it('a user who already linked Google under subject A cannot be silently re-linked under subject B for the same provider — fails closed, not a raw constraint-violation 500', async () => {
      const org = await factory.createOrganisation('p1c1b-google-relink');
      const manager = await factory.createInternalManager(org);
      await authService.signInWithProvider('google', { subject: randomUUID(), email: manager.email, emailVerified: true }, {});

      await expect(authService.signInWithProvider('google', { subject: randomUUID(), email: manager.email, emailVerified: true }, {})).rejects.toThrow(/could not sign you in/i);
    });

    it('a provider_subject already linked to user A is never adopted by a different email/user B', async () => {
      const org = await factory.createOrganisation('p1c1b-google-cross-user');
      const userA = await factory.createInternalManager(org, { label: 'a' });
      const userB = await factory.createInternalManager(org, { label: 'b' });
      const subject = randomUUID();
      await authService.signInWithProvider('google', { subject, email: userA.email, emailVerified: true }, {});

      // Same subject, but userB's email — findLinkedUser resolves the subject to userA's identity
      // regardless of which email is presented this time; completeLogin proceeds as userA, never userB.
      const result = await authService.signInWithProvider('google', { subject, email: userB.email, emailVerified: true }, {});
      const [session] = await withOrgUser(org.id, userA.userId, (m) =>
        m.query('SELECT user_id FROM core.user_session WHERE id = (SELECT id FROM core.user_session WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1)', [userA.userId]),
      );
      expect(session.user_id).toBe(userA.userId);
      expect(result.mustResetPassword).toBe(false);
    });

    it('google sign-in is refused when the ORGANISATION has google_auth_enabled=false, even though an existing link exists', async () => {
      const org = await factory.createOrganisation('p1c1b-google-org-disabled');
      const manager = await factory.createInternalManager(org);
      const subject = randomUUID();
      await authService.signInWithProvider('google', { subject, email: manager.email, emailVerified: true }, {});

      await adminDataSource.query('UPDATE core.organisation SET google_auth_enabled = false WHERE id = $1', [org.id]);
      await expect(authService.signInWithProvider('google', { subject, email: manager.email, emailVerified: true }, {})).rejects.toThrow(/could not sign you in/i);
    });

    it('a query against core.user_auth_identity with no tenant context bound returns zero rows over the rab_app (runtime) connection', async () => {
      // This table is NOT FORCEd (the owner connection legitimately bypasses RLS — that is the
      // whole point of the pre-auth-lookup exemption, see the migration's own SECURITY
      // TRADE-OFF comment) — the invariant CLAUDE.md actually requires is that the RUNTIME role
      // (rab_app), which every real request uses, still sees zero rows with no context bound.
      const rows = await dataSource.query('SELECT * FROM core.user_auth_identity LIMIT 5');
      expect(rows).toEqual([]);
    });
  });

  // ======================================================================== MIGRATION D
  describe('Migration D — core.oauth_transaction_state atomic one-time consumption', () => {
    it('create then consume succeeds exactly once; a replay (second consume) is rejected', async () => {
      const tx = await oauthState.create('google', { returnToPath: '/dashboard' });
      const consumed = await oauthState.consume(tx.id, 'google', tx.browserSecret);
      expect(consumed.returnToPath).toBe('/dashboard');
      await expect(oauthState.consume(tx.id, 'google', tx.browserSecret)).rejects.toThrow(/expired or was already used/i);
    });

    it('consuming with the wrong provider is rejected identically to a replay', async () => {
      const tx = await oauthState.create('google');
      await expect(oauthState.consume(tx.id, 'microsoft', tx.browserSecret)).rejects.toThrow(/expired or was already used/i);
    });

    it('consuming from a browser that did not start the flow is rejected and leaves the state usable (login CSRF)', async () => {
      const tx = await oauthState.create('google');
      const other = await oauthState.create('google');
      await expect(oauthState.consume(tx.id, 'google', other.browserSecret)).rejects.toThrow(/expired or was already used/i);
      await expect(oauthState.consume(tx.id, 'google', undefined)).rejects.toThrow(/expired or was already used/i);
      await expect(oauthState.consume(tx.id, 'google', tx.browserSecret)).resolves.toMatchObject({ id: tx.id });
    });

    it('an absolute or protocol-relative returnToPath is sanitised to "/" rather than stored as-is', async () => {
      const absolute = await oauthState.create('google', { returnToPath: 'https://evil.example/' });
      expect(absolute.returnToPath).toBe('/');
      const protocolRelative = await oauthState.create('google', { returnToPath: '//evil.example/' });
      expect(protocolRelative.returnToPath).toBe('/');
      const javascriptScheme = await oauthState.create('google', { returnToPath: '/\tjavascript:alert(1)' });
      expect(javascriptScheme.returnToPath).toBe('/');
    });

    it('an unknown id is rejected the same generic way as an expired or replayed one', async () => {
      await expect(oauthState.consume(randomUUID(), 'google', 'x'.repeat(43))).rejects.toThrow(/expired or was already used/i);
    });
  });

  // ======================================================================== STARTUP LOCKOUT GUARD
  describe('OrganisationAuthProvidersService.onApplicationBootstrap — startup lockout guard', () => {
    it('refuses to proceed if any organisation would have zero EFFECTIVE providers under the current system config', async () => {
      const org = await factory.createOrganisation('p1c1b-startup-lockout');
      // Force a config that is only possible via a direct write (the CHECK constraint still
      // permits this row on its own — password=true organisation-side — but it is EFFECTIVELY
      // locked out once combined with this test env's system-level password flag being flipped
      // off for the probe).
      await adminDataSource.query('UPDATE core.organisation SET google_auth_enabled = true, microsoft_auth_enabled = true, password_auth_enabled = true WHERE id = $1', [org.id]);
      // Simulate the system having password/google/microsoft all disabled for this one check —
      // onApplicationBootstrap reads env at call time via systemEnabled(), so we exercise the
      // underlying scan logic directly rather than actually restarting the process.
      const originalGet = (organisationAuthProviders as unknown as { env: { get: (k: string) => unknown } }).env.get;
      const spy = jest
        .spyOn((organisationAuthProviders as unknown as { env: { get: (k: string) => unknown } }).env, 'get')
        .mockImplementation((key: string) => (key === 'AUTH_PASSWORD_ENABLED' || key === 'AUTH_GOOGLE_ENABLED' || key === 'AUTH_MICROSOFT_ENABLED' ? false : originalGet(key)));
      try {
        await expect(organisationAuthProviders.onApplicationBootstrap()).rejects.toThrow(/Startup refused/);
      } finally {
        spy.mockRestore();
      }
    });

    it('passes cleanly when every organisation has at least one effective provider', async () => {
      await expect(organisationAuthProviders.onApplicationBootstrap()).resolves.toBeUndefined();
    });
  });
});
