import 'reflect-metadata';

// Lane D (owner decision M10-3) — "Continue as …?" confirmation before a cross-host login handoff is consumed, on the
// REAL `core.login_handoff_peek` (MfaHandoffFollowups1786719980000). Same switches as login-handoff-wave4.
const ORIGINAL = Object.fromEntries(
  ['WORKSPACE_BASE_DOMAIN', 'CORS_ORIGINS', 'WORKSPACE_HOST_ROUTING_ENABLED', 'WORKSPACE_SUBDOMAIN_ORIGIN_TRUST_ENABLED', 'AUTH_LOGIN_HANDOFF_ENABLED'].map((k) => [k, process.env[k]]),
);
process.env.WORKSPACE_BASE_DOMAIN = 'rab.test';
process.env.CORS_ORIGINS = 'http://localhost:5173';
process.env.WORKSPACE_HOST_ROUTING_ENABLED = 'true';
process.env.WORKSPACE_SUBDOMAIN_ORIGIN_TRUST_ENABLED = 'true';
process.env.AUTH_LOGIN_HANDOFF_ENABLED = 'true';

import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { AppModule } from '../../app.module';
import { LoginHandoffController } from '../../engine/core-modules/auth/login-handoff/login-handoff.controller';
import { AuthCacheRedisClientProvider } from '../../engine/core-modules/auth/services/auth-cache-redis-client.provider';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { StepUpReauthService } from '../../engine/core-modules/auth/services/step-up-reauth.service';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { RATE_LIMIT_REQUIRED } from '../../engine/core-modules/throttler/rab-throttler.guard';
import { createAdminDataSource } from './helpers/admin-datasource';
import { TestIdentity, TestIdentityFactory } from './helpers/test-identities';

const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;
const DEFAULT_ORIGIN = 'http://localhost:5173';
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

describeIfDb('lane D — login handoff "Continue as …?" peek (integration, real functions)', () => {
  jest.setTimeout(300_000);

  let app: INestApplication;
  let owner: DataSource;
  let factory: TestIdentityFactory;
  let stepUp: StepUpReauthService;
  let redis: AuthCacheRedisClientProvider;
  let a: TestIdentity;
  let b: TestIdentity;
  const labelA = `ldpa-${randomUUID().slice(0, 8)}`;
  const labelB = `ldpb-${randomUUID().slice(0, 8)}`;
  const http = () => request(app.getHttpServer());

  const setCookies = (res: request.Response): string[] => ([] as string[]).concat(res.headers['set-cookie'] ?? []);
  const sessionCookie = (res: request.Response): string | undefined => setCookies(res).find((c) => c.startsWith('crewflow_session='))?.split(';')[0];

  async function signInDefault(who: TestIdentity): Promise<string> {
    const res = await http().post('/rest/v1/auth/login').set('Origin', DEFAULT_ORIGIN).send({ email: who.email, password: who.password });
    expect(res.status).toBe(200);
    return sessionCookie(res)!;
  }
  const createHandoff = (cookie: string) => http().post('/rest/v1/auth/login-handoff').set('Origin', DEFAULT_ORIGIN).set('Cookie', cookie).send({});
  const tokenOf = (redirectUrl: string) => new URL(redirectUrl).hash.replace(/^#t=/, '');
  const mint = async (who: TestIdentity) => tokenOf((await createHandoff(await signInDefault(who))).body.redirectUrl);

  const onHost = (route: 'peek' | 'exchange', label: string | null, body: unknown, opts: { origin?: string | null } = {}) => {
    const req = http().post(`/rest/v1/auth/login-handoff/${route}`);
    if (label) req.set('Host', `${label}.rab.test`);
    const origin = opts.origin === undefined ? (label ? `http://${label}.rab.test` : DEFAULT_ORIGIN) : opts.origin;
    if (origin) req.set('Origin', origin);
    return req.send(body as object);
  };
  const handoffRow = async (token: string) =>
    (await owner.query(`SELECT consumed_at, expires_at FROM core.login_handoff WHERE token_hash = $1`, [sha256(token)]))[0] as { consumed_at: Date | null; expires_at: Date };
  const maskedOf = (email: string) => `${email.split('@')[0]!.slice(0, 1)}***@${email.split('@')[1]}`;

  async function readyWorkspace(who: TestIdentity, label: string, name: string): Promise<void> {
    const cookie = await signInDefault(who);
    const created = await http().post('/rest/v1/manager-workspaces').set('Origin', DEFAULT_ORIGIN).set('Cookie', cookie).send({ name, subdomain: label });
    expect(created.status).toBe(201);
    expect(created.body.schemaStatus).toBe('READY');
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    app.use(cookieParser());
    await app.init();
    owner = createAdminDataSource();
    await owner.initialize();
    const [{ present }] = await owner.query(`SELECT to_regprocedure('core.login_handoff_peek(text,text)') IS NOT NULL AS present`);
    if (!present) throw new Error('core.login_handoff_peek is missing: apply MfaHandoffFollowups1786719980000 before running this suite');
    stepUp = moduleRef.get(StepUpReauthService);
    redis = moduleRef.get(AuthCacheRedisClientProvider);
    factory = new TestIdentityFactory({ app, dataSource: moduleRef.get(DataSource), adminDataSource: owner, tenantContext: moduleRef.get(TenantContextService), passwordHashing: moduleRef.get(PasswordHashingService) });
    a = (await factory.createOrganisationWithManagers(1, { permissions: 'production', workspace: false, label: 'ldpa' })).managers[0]!;
    b = (await factory.createOrganisationWithManagers(1, { permissions: 'production', workspace: false, label: 'ldpb' })).managers[0]!;
    await readyWorkspace(a, labelA, `Alpha ${labelA}`);
    await readyWorkspace(b, labelB, `Bravo ${labelB}`);
  });

  afterEach(async () => {
    await owner.query(`UPDATE core.login_handoff SET consumed_at = now() WHERE consumed_at IS NULL AND user_id = ANY($1::uuid[])`, [[a.userId, b.userId]]);
  });

  afterAll(async () => {
    await owner?.destroy();
    await app?.close();
    for (const [key, value] of Object.entries(ORIGINAL)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('peek on the audience host returns ONLY a masked email, the workspace name and the expiry — and never consumes or extends the token', async () => {
    const token = await mint(a);
    const before = await handoffRow(token);
    const first = await onHost('peek', labelA, { token });
    expect(first.status).toBe(200);
    expect(Object.keys(first.body).sort()).toEqual(['expiresAt', 'maskedEmail', 'workspaceName']);
    expect(first.body.maskedEmail).toBe(maskedOf(a.email));
    expect(first.body.maskedEmail).not.toContain(a.email.split('@')[0]);
    expect(first.body.workspaceName).toBe(`Alpha ${labelA}`);
    expect(JSON.stringify(first.body)).not.toMatch(new RegExp(`${a.userId}|${a.organisationId}|lho_`));
    expect(setCookies(first)).toEqual([]); // no session, no cookie of any kind
    // Twice more: still unconsumed, same expiry (read-only, never extended).
    expect((await onHost('peek', labelA, { token })).status).toBe(200);
    const after = await handoffRow(token);
    expect(after.consumed_at).toBeNull();
    expect(new Date(after.expires_at).getTime()).toBe(new Date(before.expires_at).getTime());
    // The confirmed exchange still works afterwards.
    const done = await onHost('exchange', labelA, { token });
    expect(done.status).toBe(200);
    expect(sessionCookie(done)).toBeTruthy();
    // …and a peek after the exchange is refused like any dead token.
    expect((await onHost('peek', labelA, { token })).status).toBe(401);
  });

  it('ABUSE: every failure is the SAME 401 — garbage, unknown, expired, consumed, wrong workspace host, default host, unknown host — and a wrong-host PEEK burns nothing', async () => {
    const uniform = (res: request.Response) => {
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('LOGIN_HANDOFF_INVALID');
      expect(res.body.message).toBe('This sign-in link has expired. Please sign in again.');
      expect(setCookies(res)).toEqual([]);
    };
    uniform(await onHost('peek', labelA, { token: 'garbage' }));
    uniform(await onHost('peek', labelA, { token: `lho_${randomBytes(32).toString('base64url')}` })); // well-formed, unknown

    const tokenA = await mint(a);
    uniform(await onHost('peek', labelB, { token: tokenA })); // B's host: wrong audience
    uniform(await onHost('peek', null, { token: tokenA })); // default host
    uniform(await onHost('peek', `ghost-${randomUUID().slice(0, 6)}`, { token: tokenA }, { origin: DEFAULT_ORIGIN })); // unknown host
    // Unlike a wrong-host EXCHANGE (which burns), a wrong-host peek leaves the token usable on its own host.
    expect((await handoffRow(tokenA)).consumed_at).toBeNull();
    expect((await onHost('peek', labelA, { token: tokenA })).status).toBe(200);

    const expired = await mint(a);
    await owner.query(`UPDATE core.login_handoff SET created_at = created_at - interval '5 minutes', expires_at = expires_at - interval '5 minutes' WHERE token_hash = $1`, [sha256(expired)]);
    uniform(await onHost('peek', labelA, { token: expired }));

    const consumed = await mint(a);
    expect((await onHost('exchange', labelA, { token: consumed })).status).toBe(200);
    uniform(await onHost('peek', labelA, { token: consumed }));

    // A dead source session (logout) or a changed account also reads as the same 401.
    const source = await signInDefault(a);
    const viaLogout = tokenOf((await createHandoff(source)).body.redirectUrl);
    expect((await http().post('/rest/v1/auth/logout').set('Origin', DEFAULT_ORIGIN).set('Cookie', source).send({})).status).toBe(204);
    uniform(await onHost('peek', labelA, { token: viaLogout }));
  });

  it('ABUSE: login CSRF / transport — untrusted or missing Origin → 403, a form body is refused, a body cannot pick the audience; none of it consumes', async () => {
    const token = await mint(a);
    expect((await onHost('peek', labelA, { token }, { origin: 'http://evil.example' })).status).toBe(403);
    expect((await onHost('peek', labelA, { token }, { origin: null })).status).toBe(403);
    const form = await http().post('/rest/v1/auth/login-handoff/peek').set('Host', `${labelA}.rab.test`).set('Origin', `http://${labelA}.rab.test`).type('form').send({ token });
    expect([400, 403, 415]).toContain(form.status);
    expect((await onHost('peek', labelB, { token, host: labelA })).status).toBe(400); // forbidNonWhitelisted
    expect((await handoffRow(token)).consumed_at).toBeNull();
    expect((await onHost('peek', labelA, { token })).status).toBe(200);
  });

  it('ABUSE: attacker-sent token — a link minted by the ATTACKER for THEIR account shows THEIR masked email and workspace, issues nothing, and is useless on the victim\'s own host', async () => {
    // The attacker (b) signs in to their own account and mints a handoff to their own workspace host, then sends the
    // victim the `<b-host>/auth/handoff#t=…` link. The landing page peeks before anything else.
    const attackerToken = await mint(b);
    const shown = await onHost('peek', labelB, { token: attackerToken });
    expect(shown.status).toBe(200);
    expect(shown.body.maskedEmail).toBe(maskedOf(b.email)); // NOT the victim's identity: the victim can see it isn't them
    // (Masked emails can coincide — first letter + domain — so the attacker's workspace NAME is what makes it obvious.)
    expect(shown.body.workspaceName).toBe(`Bravo ${labelB}`);
    expect(shown.body.workspaceName).not.toBe(`Alpha ${labelA}`);
    expect(setCookies(shown)).toEqual([]);
    // The victim declines (the page simply does not exchange): no session exists for anyone, the token stays unused and
    // expires on its own; nothing was written for the victim.
    expect((await handoffRow(attackerToken)).consumed_at).toBeNull();
    const victimSessions = (await owner.query(`SELECT count(*)::int AS n FROM core.user_session WHERE user_id = $1 AND revoked_at IS NULL`, [a.userId]))[0].n;
    // Audience binding still holds: the attacker's token on the VICTIM's workspace host is the uniform 401 (peek and exchange).
    expect((await onHost('peek', labelA, { token: attackerToken })).status).toBe(401);
    expect((await owner.query(`SELECT count(*)::int AS n FROM core.user_session WHERE user_id = $1 AND revoked_at IS NULL`, [a.userId]))[0].n).toBe(victimSessions);
  });

  it('peek is per-IP throttled and marked rate-limit-required (fails closed with 503 if the limiter store is down)', () => {
    const handler = LoginHandoffController.prototype.peek;
    expect(Reflect.getMetadata('THROTTLER:LIMITdefault', handler)).toBe(20);
    expect(Reflect.getMetadata('THROTTLER:TTLdefault', handler)).toBe(60_000);
    expect(Reflect.getMetadata(RATE_LIMIT_REQUIRED, handler)).toBe(true);
  });

  it('step-up (M10-2): the handed-off session carries the source session\'s fresh sign-in grant (never a new one) — without it, step-up is required', async () => {
    const latestSession = async () => (await owner.query(`SELECT id FROM core.user_session WHERE user_id = $1 AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1`, [a.userId]))[0].id as string;
    const ctxFor = (sessionId: string) => ({ organisationId: a.organisationId, workspaceId: null, userId: a.userId, sessionId });

    // Fresh sign-in on the default host → that session holds a grant → handed over to the workspace-host session.
    const token = await mint(a);
    expect((await onHost('exchange', labelA, { token })).status).toBe(200);
    await expect(stepUp.assertRecentStepUp(ctxFor(await latestSession()))).resolves.toBeUndefined();

    // Source session whose grant is gone (older than the window): the handoff does NOT mint one.
    const source = await signInDefault(a);
    const sourceId = await latestSession();
    await redis.client.del(`crewflow:test:step-up:${sha256(sourceId)}`);
    const token2 = tokenOf((await createHandoff(source)).body.redirectUrl);
    expect((await onHost('exchange', labelA, { token: token2 })).status).toBe(200);
    await expect(stepUp.assertRecentStepUp(ctxFor(await latestSession()))).rejects.toMatchObject({ response: { code: 'STEP_UP_REQUIRED' } });
  });
});
