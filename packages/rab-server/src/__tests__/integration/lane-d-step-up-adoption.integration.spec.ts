import 'reflect-metadata';
import { ForbiddenException, INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createHash, randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { AppModule } from '../../app.module';
import { AuthCacheRedisClientProvider } from '../../engine/core-modules/auth/services/auth-cache-redis-client.provider';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { STEP_UP_ACTIONS, StepUpReauthService } from '../../engine/core-modules/auth/services/step-up-reauth.service';
import { EnvironmentService } from '../../engine/core-modules/environment/environment.service';
import { EnvironmentVariables } from '../../engine/core-modules/environment/environment-variables';
import { WORKER_SCHEDULER_STATUS_KEY } from '../../engine/worker-shared/heartbeat.constants';
import { AdminPanelService } from '../../engine/core-modules/platform-admin/admin-panel.service';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { StaffService } from '../../modules/staff/services/staff.service';
import { createAdminDataSource } from './helpers/admin-datasource';
import { codeAt, secretFromOtpauth } from './helpers/mfa-test-kit';
import { TestIdentity, TestIdentityFactory } from './helpers/test-identities';

/**
 * Lane D (owner decision M10-2): `StepUpReauthService.assertRecentStepUp` had ZERO callers, so every "sensitive" action
 * that was not one of the five legacy password-confirmed ones ran on a session of any age. It is now called in the
 * SERVICE of every action in `STEP_UP_ACTIONS`. A "stale" session (signed in longer ago than AUTH_STEP_UP_WINDOW_SECONDS)
 * is simulated by deleting that session's grant from Redis — exactly what its expiry does.
 *
 * Every operation: refused 403 STEP_UP_REQUIRED on a stale session (nothing written, refusal audited with the action),
 * allowed after POST /auth/step-up. MFA-enrolled actors must include the code. Admin Inspect is refused. Service-direct
 * calls (no controller / guard) are refused the same way. The legacy password sites now honour the session's grant.
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;
const ORIGIN = 'http://localhost:5173';
const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');

describeIfDb('lane D — step-up on sensitive operations (integration)', () => {
  jest.setTimeout(300_000);

  let app: INestApplication;
  let owner: DataSource;
  let factory: TestIdentityFactory;
  let redis: AuthCacheRedisClientProvider;
  let stepUp: StepUpReauthService;
  const overrides: Partial<Record<keyof EnvironmentVariables, unknown>> = {};
  const http = () => request(app.getHttpServer());
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
  const sidOf = (token: string) => (JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8')) as { sid: string }).sid;
  const grantKey = (sid: string) => `crewflow:test:step-up:${sha256(sid)}`;

  /** A real sign-in, then the window "passes" for this session (its grant expires = is removed). */
  async function staleToken(who: TestIdentity): Promise<string> {
    const token = await factory.login(who, { applicationTarget: 'manager_web' });
    await redis.client.del(grantKey(sidOf(token)));
    return token;
  }
  const stepUpWith = (token: string, body: Record<string, string>) => http().post('/rest/v1/auth/step-up').set(bearer(token)).set('Origin', ORIGIN).send(body);
  const refusals = async (userId: string, action: string) =>
    (
      await owner.query(`SELECT count(*)::int AS n FROM core.audit_log WHERE actor_user_id = $1 AND action = 'auth.step_up_failed' AND metadata->>'action' = $2`, [userId, action])
    )[0].n as number;

  let org: { id: string };
  let manager: TestIdentity;
  let admin: TestIdentity;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    const env = moduleRef.get(EnvironmentService);
    const realGet = env.get.bind(env);
    jest.spyOn(env, 'get').mockImplementation(((key: keyof EnvironmentVariables) => (key in overrides ? overrides[key] : realGet(key))) as EnvironmentService['get']);
    await app.init();
    owner = createAdminDataSource();
    await owner.initialize();
    redis = moduleRef.get(AuthCacheRedisClientProvider);
    stepUp = moduleRef.get(StepUpReauthService);
    factory = new TestIdentityFactory({ app, dataSource: moduleRef.get(DataSource), adminDataSource: owner, tenantContext: moduleRef.get(TenantContextService), passwordHashing: moduleRef.get(PasswordHashingService) });
    const seeded = await factory.createOrganisationWithManagers(2, { permissions: 'production', workspace: true, label: 'ldsu', firstIsPlatformAdmin: true });
    org = seeded.organisation;
    [admin, manager] = seeded.managers as [TestIdentity, TestIdentity];
    (app as unknown as { __services: unknown }).__services = { staff: moduleRef.get(StaffService), panel: moduleRef.get(AdminPanelService) };
  });

  afterEach(() => {
    for (const key of Object.keys(overrides)) delete overrides[key as keyof EnvironmentVariables];
  });

  afterAll(async () => {
    if (owner?.isInitialized && org) await owner.query(`UPDATE core.platform_config SET maintenance_mode_enabled = false WHERE organisation_id = $1`, [org.id]).catch(() => undefined);
    await owner?.destroy();
    await app?.close();
  });

  it('ABUSE: every gated route refuses a STALE session with 403 STEP_UP_REQUIRED, writes nothing, and audits the refusal with its action', async () => {
    const staff = await factory.createStaff(org, { owner: manager, label: 'ldsus' });
    const vm = await factory.createVenueManager(org, { owner: manager, label: 'ldsuv' });
    const ceo = await factory.createCeo(org, { permissions: 'production' });
    const mgrToken = await staleToken(manager);
    const adminToken = await staleToken(admin);
    const ceoToken = await staleToken(ceo);
    const someone = randomUUID();
    // AI Phase 5a: a HIGH-impact (12 people) PENDING proposal of the CEO, written below as a fixture by the bootstrap identity.
    const highImpactProposalId = randomUUID();
    const routes: Array<{ token: string; actor: TestIdentity; method: 'post' | 'put' | 'patch' | 'delete'; path: string; body?: object; action: string }> = [
      { token: adminToken, actor: admin, method: 'patch', path: `/rest/v1/admin/organisations/${org.id}/settings/security`, body: { passwordAuthEnabled: true }, action: 'organisation.auth_providers.update' },
      { token: adminToken, actor: admin, method: 'patch', path: '/rest/v1/admin/config/smtp', body: { host: 'smtp.example.com', port: 587, encryption: 'starttls', fromEmail: 'noreply@example.com' }, action: 'platform.smtp_config.update' },
      { token: adminToken, actor: admin, method: 'patch', path: '/rest/v1/admin/config/maintenance-mode', body: { enabled: true, reason: 'stale probe' }, action: 'platform.maintenance_mode.update' },
      { token: adminToken, actor: admin, method: 'post', path: `/rest/v1/admin/inspect/${staff.userId}`, action: 'platform.admin_inspect.start' },
      { token: mgrToken, actor: manager, method: 'post', path: '/rest/v1/roles', body: { name: `R ${randomUUID().slice(0, 6)}`, assignableToMembers: true, readAllObjects: false, objects: [] }, action: 'role.create' },
      { token: mgrToken, actor: manager, method: 'put', path: `/rest/v1/roles/${someone}`, body: { name: 'X', assignableToMembers: true, readAllObjects: false, objects: [] }, action: 'role.update' },
      { token: mgrToken, actor: manager, method: 'delete', path: `/rest/v1/roles/${someone}`, action: 'role.delete' },
      { token: mgrToken, actor: manager, method: 'patch', path: `/rest/v1/members/${someone}/role`, body: { roleId: someone }, action: 'member.role.change' },
      { token: mgrToken, actor: manager, method: 'post', path: `/rest/v1/members/${someone}/suspend`, action: 'member.suspend' },
      { token: mgrToken, actor: manager, method: 'post', path: `/rest/v1/members/${someone}/reinstate`, action: 'member.reinstate' },
      { token: mgrToken, actor: manager, method: 'post', path: `/rest/v1/staff/${staff.profileId}/deactivate`, action: 'user.deactivate' },
      { token: mgrToken, actor: manager, method: 'post', path: `/rest/v1/staff/${staff.profileId}/reactivate`, action: 'user.reactivate' },
      { token: mgrToken, actor: manager, method: 'post', path: `/rest/v1/staff/${staff.profileId}/reset-password`, action: 'user.password_reset' },
      { token: mgrToken, actor: manager, method: 'patch', path: `/rest/v1/staff/${staff.profileId}/email`, body: { email: `taken-${randomUUID().slice(0, 6)}@example.test` }, action: 'user.email.change' },
      { token: mgrToken, actor: manager, method: 'patch', path: `/rest/v1/staff/${staff.profileId}/pending-email`, body: { email: `pending-${randomUUID().slice(0, 6)}@example.test` }, action: 'user.pending_email.change' },
      { token: mgrToken, actor: manager, method: 'post', path: `/rest/v1/venue-managers/${vm.profileId}/deactivate`, action: 'user.deactivate' },
      { token: mgrToken, actor: manager, method: 'post', path: `/rest/v1/venue-managers/${vm.profileId}/reset-password`, action: 'user.password_reset' },
      { token: ceoToken, actor: ceo, method: 'post', path: `/rest/v1/managers/${manager.profileId}/deactivate`, action: 'user.deactivate' },
      { token: ceoToken, actor: ceo, method: 'post', path: `/rest/v1/managers/${manager.profileId}/reset-password`, action: 'user.password_reset' },
      // Account security step 1 (P4): an admin's 2FA reset of another account, with no inline password, is a step-up action.
      { token: adminToken, actor: admin, method: 'post', path: `/rest/v1/admin/users/${staff.userId}/mfa/reset`, body: { reason: 'lost phone' }, action: 'user.mfa.reset' },
      { token: ceoToken, actor: ceo, method: 'patch', path: `/rest/v1/managers/${manager.profileId}/email`, body: { email: `mgr-${randomUUID().slice(0, 6)}@example.test` }, action: 'user.email.change' },
      // Admin panel follow-up (B3 / P7): platform-admin membership, suspension, sign-out-everywhere, queue actions, replay.
      { token: adminToken, actor: admin, method: 'post', path: `/rest/v1/admin/platform-admins/${someone}`, body: { reason: 'stale probe' }, action: 'platform.admin.grant' },
      { token: adminToken, actor: admin, method: 'delete', path: `/rest/v1/admin/platform-admins/${someone}`, body: { reason: 'stale probe' }, action: 'platform.admin.revoke' },
      { token: adminToken, actor: admin, method: 'post', path: `/rest/v1/admin/organisations/${org.id}/suspend`, body: { reason: 'stale probe', confirmSlug: 'not-checked-before-step-up' }, action: 'organisation.suspend' },
      { token: adminToken, actor: admin, method: 'post', path: `/rest/v1/admin/organisations/${org.id}/reactivate`, body: { reason: 'stale probe' }, action: 'organisation.reactivate' },
      { token: adminToken, actor: admin, method: 'post', path: `/rest/v1/admin/users/${staff.userId}/sessions/revoke`, body: { reason: 'stale probe' }, action: 'user.sessions.revoke' },
      { token: adminToken, actor: admin, method: 'post', path: '/rest/v1/admin/queues/rab-email/jobs/retry', body: { jobIds: ['stale-probe'], reason: 'stale probe' }, action: 'platform.queue_jobs.retry' },
      // Delete is offered on the scan queues only, which are listed while a bullmq scheduler status is live (set below).
      { token: adminToken, actor: admin, method: 'post', path: '/rest/v1/admin/queues/crewflow-scan-email/jobs/delete', body: { jobIds: ['stale-probe'], reason: 'stale probe' }, action: 'platform.queue_jobs.delete' },
      { token: adminToken, actor: admin, method: 'post', path: `/rest/v1/admin/outbox/organisations/${org.id}/emails/${someone}/replay`, body: { reason: 'stale probe' }, action: 'platform.email.replay' },
      // AI Phase 1 (AI-F2): the per-organisation AI switch.
      { token: adminToken, actor: admin, method: 'put', path: `/rest/v1/admin/ai/organisations/${org.id}/setting`, body: { enabled: true, reason: 'stale probe' }, action: 'organisation.ai.update' },
      // AI Phase 1 real models (D7): the CEO pinning / clearing a tier's model in Settings → AI.
      { token: ceoToken, actor: ceo, method: 'put', path: '/rest/v1/ai/settings/models/fast', body: { modelId: 'anthropic-claude-haiku-5-5', reason: 'stale probe' }, action: 'organisation.ai.model.update' },
      { token: ceoToken, actor: ceo, method: 'delete', path: '/rest/v1/ai/settings/models/fast', body: { reason: 'stale probe' }, action: 'organisation.ai.model.update' },
      // AI Phase 5a: approving a high-impact AI write proposal (> 10 people) needs this session's step-up (+ a reason).
      { token: ceoToken, actor: ceo, method: 'post', path: `/rest/v1/ai/proposals/${highImpactProposalId}/approve`, body: { reason: 'stale probe' }, action: 'ai.proposal.approve_high_impact' },
      // AI Phase 4 (P4-D4): every skill write, built-in toggles included.
      { token: ceoToken, actor: ceo, method: 'post', path: '/rest/v1/ai/settings/skills', body: { name: 'stale-probe', label: 'Stale probe', description: 'A stale probe.', content: 'Stale probe.', reason: 'stale probe' }, action: 'organisation.ai.skill.update' },
      { token: ceoToken, actor: ceo, method: 'post', path: '/rest/v1/ai/settings/skills/builtin/crewflow-help/deactivate', body: { reason: 'stale probe' }, action: 'organisation.ai.skill.update' },
      // C1 / CD-4 (p4 merge): setting or clearing the workspace instructions.
      { token: ceoToken, actor: ceo, method: 'put', path: '/rest/v1/ai/settings/instructions', body: { content: 'Stale probe.', reason: 'stale probe' }, action: 'organisation.ai.instructions.update' },
      { token: ceoToken, actor: ceo, method: 'delete', path: '/rest/v1/ai/settings/instructions', body: { reason: 'stale probe' }, action: 'organisation.ai.instructions.update' },
    ];
    // The settings routes exist only while AI is on for the platform and the organisation (else the uniform 404 comes
    // before the step-up); the switch row is a fixture write as the bootstrap identity.
    overrides.AI_ENABLED = true;
    await owner.query(`INSERT INTO core.organisation_ai_setting (organisation_id, enabled) VALUES ($1, true) ON CONFLICT (organisation_id) DO UPDATE SET enabled = true`, [org.id]);
    {
      const [conv] = await owner.query(`INSERT INTO core.ai_conversation (organisation_id, workspace_id, user_id, message_count) VALUES ($1, $2, $3, 2) RETURNING id`, [org.id, ceo.workspaceId, ceo.userId]);
      const [msg] = await owner.query(`INSERT INTO core.ai_message (organisation_id, workspace_id, user_id, conversation_id, seq, role, content) VALUES ($1, $2, $3, $4, 1, 'user', 'probe') RETURNING id`, [org.id, ceo.workspaceId, ceo.userId, conv.id]);
      const [turn] = await owner.query(
        `INSERT INTO core.ai_message (organisation_id, workspace_id, user_id, conversation_id, seq, role, status, request_message_id, session_id) VALUES ($1, $2, $3, $4, 2, 'assistant', 'running', $5, $6) RETURNING id`,
        [org.id, ceo.workspaceId, ceo.userId, conv.id, msg.id, randomUUID()],
      );
      const start = new Date(Date.now() + 3 * 86_400_000);
      const args = { venueId: randomUUID(), jobRoleId: randomUUID(), startsAt: start.toISOString(), endsAt: new Date(start.getTime() + 4 * 3_600_000).toISOString(), requiredCount: 12 };
      await owner.query(
        `INSERT INTO core.ai_action_proposal (id, organisation_id, workspace_id, user_id, conversation_id, turn_id, tool_call_id, tool, arguments, summary, snapshot_hash, impact, affected_count, editable_fields)
         VALUES ($1, $2, $3, $4, $5, $6, 'call_ldsu', 'create_draft_shift', $7::jsonb, 'probe', $8, 'high', 12, '{}')`,
        [highImpactProposalId, org.id, ceo.workspaceId, ceo.userId, conv.id, turn.id, JSON.stringify(args), 'a'.repeat(64)],
      );
    }
    await redis.client.multi().hset(WORKER_SCHEDULER_STATUS_KEY, { mode: 'bullmq', prefix: `crewflow:test-ldsu-${randomUUID().slice(0, 8)}:bull`, reconciledAt: Date.now(), schedulers: 0 }).expire(WORKER_SCHEDULER_STATUS_KEY, 120).exec();
    const covered = new Set(routes.map((r) => r.action));
    for (const action of STEP_UP_ACTIONS) expect(covered.has(action)).toBe(true);

    const before = {
      user: await owner.query(`SELECT status, email, security_version FROM core."user" WHERE id = ANY($1) ORDER BY id`, [[staff.userId, vm.userId, manager.userId]]),
      org: await owner.query(`SELECT password_auth_enabled, security_version FROM core.organisation WHERE id = $1`, [org.id]),
      roles: (await owner.query(`SELECT count(*)::int AS n FROM core.role WHERE organisation_id = $1`, [org.id]))[0].n,
      inspect: (await owner.query(`SELECT count(*)::int AS n FROM core.admin_inspect_session WHERE admin_user_id = $1`, [admin.userId]))[0].n,
    };
    for (const r of routes) {
      const refusalsBefore = await refusals(r.actor.userId, r.action);
      const req = http()[r.method](r.path).set(bearer(r.token)).set('Origin', ORIGIN);
      const res = await (r.body ? req.send(r.body) : req.send());
      expect({ path: r.path, status: res.status, code: res.body.code }).toEqual({ path: r.path, status: 403, code: 'STEP_UP_REQUIRED' });
      expect(res.body.mfa).toBe(false);
      expect(await refusals(r.actor.userId, r.action)).toBe(refusalsBefore + 1);
    }
    expect(await owner.query(`SELECT status, email, security_version FROM core."user" WHERE id = ANY($1) ORDER BY id`, [[staff.userId, vm.userId, manager.userId]])).toEqual(before.user);
    expect(await owner.query(`SELECT password_auth_enabled, security_version FROM core.organisation WHERE id = $1`, [org.id])).toEqual(before.org);
    expect((await owner.query(`SELECT count(*)::int AS n FROM core.role WHERE organisation_id = $1`, [org.id]))[0].n).toBe(before.roles);
    expect((await owner.query(`SELECT count(*)::int AS n FROM core.admin_inspect_session WHERE admin_user_id = $1`, [admin.userId]))[0].n).toBe(before.inspect);
    await redis.client.del(WORKER_SCHEDULER_STATUS_KEY);
  });

  it('after POST /auth/step-up (password) the same session may act; a wrong password grants nothing', async () => {
    const staff = await factory.createStaff(org, { owner: manager, label: 'ldsuok' });
    const token = await staleToken(manager);
    expect((await stepUpWith(token, { currentPassword: 'not-the-password' })).status).toBe(403);
    expect((await http().post(`/rest/v1/staff/${staff.profileId}/deactivate`).set(bearer(token)).send()).status).toBe(403);
    const granted = await stepUpWith(token, { currentPassword: manager.password });
    expect(granted.status).toBe(200);
    expect(granted.body.mfa).toBe(false);
    expect([200, 201]).toContain((await http().post(`/rest/v1/staff/${staff.profileId}/deactivate`).set(bearer(token)).send()).status);
    expect([200, 201]).toContain((await http().post(`/rest/v1/staff/${staff.profileId}/reactivate`).set(bearer(token)).send()).status);
    const role = await http().post('/rest/v1/roles').set(bearer(token)).send({ name: `Ok ${randomUUID().slice(0, 6)}`, assignableToMembers: true, readAllObjects: false, objects: [] });
    expect(role.status).toBe(201);
    expect((await http().delete(`/rest/v1/roles/${role.body.id}`).set(bearer(token)).send()).status).toBe(204);

    const adminToken = await staleToken(admin);
    expect((await stepUpWith(adminToken, { currentPassword: admin.password })).status).toBe(200);
    expect((await http().patch(`/rest/v1/admin/organisations/${org.id}/settings/security`).set(bearer(adminToken)).send({ passwordAuthEnabled: true })).status).toBe(200);
    expect((await http().patch('/rest/v1/admin/config/maintenance-mode').set(bearer(adminToken)).send({ enabled: false, reason: 'after step-up' })).status).toBe(200);
    const inspected = await http().post(`/rest/v1/admin/inspect/${staff.userId}`).set(bearer(adminToken)).send();
    expect([200, 201]).toContain(inspected.status);
    // The grant belongs to THIS session only: another (stale) session of the same admin is still refused.
    const other = await staleToken(admin);
    expect((await http().patch('/rest/v1/admin/config/maintenance-mode').set(bearer(other)).send({ enabled: false, reason: 'other session' })).status).toBe(403);
  });

  it('a FRESH sign-in counts as the step-up for its own session (no prompt right after signing in); a refresh never creates one', async () => {
    const staff = await factory.createStaff(org, { owner: manager, label: 'ldsufresh' });
    const fresh = await factory.login(manager, { applicationTarget: 'manager_web' });
    expect([200, 201]).toContain((await http().post(`/rest/v1/staff/${staff.profileId}/deactivate`).set(bearer(fresh)).send()).status);

    // Mobile-style login (refresh token in the body) → expire the grant → refresh → still refused.
    const tokens = await factory.loginTokens(manager);
    await redis.client.del(grantKey(sidOf(tokens.accessToken)));
    const refreshed = await http().post('/rest/v1/auth/refresh').set('x-client-platform', 'mobile').send({ refreshToken: tokens.refreshToken });
    expect(refreshed.status).toBe(200);
    expect((await http().post(`/rest/v1/staff/${staff.profileId}/reactivate`).set(bearer(refreshed.body.accessToken)).send()).status).toBe(403);
  });

  it('ABUSE: an MFA-ENROLLED actor must present the code — password alone grants nothing; the code is single use', async () => {
    const { managers } = await factory.createOrganisationWithManagers(1, { permissions: 'production', workspace: true, label: 'ldsumfa' });
    const who = managers[0]!;
    const setup = await factory.login(who, { applicationTarget: 'manager_web' });
    const started = await http().post('/rest/v1/auth/mfa/enrolment').set(bearer(setup)).send({ currentPassword: who.password });
    const secret = secretFromOtpauth(started.body.otpauthUri);
    expect((await http().post('/rest/v1/auth/mfa/enrolment/confirm').set(bearer(setup)).send({ code: codeAt(secret, -1) })).status).toBe(200);
    // Enrolling ended every OTHER session; this one's (password-only) sign-in grant no longer satisfies an MFA account.
    const roleBody = () => ({ name: `M ${randomUUID().slice(0, 6)}`, assignableToMembers: true, readAllObjects: false, objects: [] });
    const refused = await http().post('/rest/v1/roles').set(bearer(setup)).send(roleBody());
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({ code: 'STEP_UP_REQUIRED', mfa: true });

    const passwordOnly = await stepUpWith(setup, { currentPassword: who.password });
    expect(passwordOnly.status).toBe(403);
    expect(passwordOnly.body.code).toBe('STEP_UP_MFA_INVALID');
    expect((await http().post('/rest/v1/roles').set(bearer(setup)).send(roleBody())).status).toBe(403);

    const code = codeAt(secret, 0);
    expect((await stepUpWith(setup, { currentPassword: who.password, code })).status).toBe(200);
    expect((await http().post('/rest/v1/roles').set(bearer(setup)).send(roleBody())).status).toBe(201);
    // Replay: the same code cannot mint a second grant (the step is burned).
    await redis.client.del(grantKey(sidOf(setup)));
    const replay = await stepUpWith(setup, { currentPassword: who.password, code });
    expect(replay.status).toBe(403);
    expect(replay.body.code).toBe('STEP_UP_MFA_INVALID');
  });

  it('ABUSE: service-direct calls (no controller, no guard) are refused the same way — no session, a stale session, or Admin Inspect', async () => {
    const services = (app as unknown as { __services: { staff: StaffService; panel: AdminPanelService } }).__services;
    const staff = await factory.createStaff(org, { owner: manager, label: 'ldsusvc' });
    const base = { organisationId: manager.organisationId, workspaceId: manager.workspaceId, userId: manager.userId, role: '' };
    await expect(services.staff.deactivate(base, staff.profileId!)).rejects.toMatchObject({ response: { code: 'STEP_UP_REQUIRED' } });
    const stale = await staleToken(manager);
    await expect(services.staff.deactivate({ ...base, sessionId: sidOf(stale) }, staff.profileId!)).rejects.toMatchObject({ response: { code: 'STEP_UP_REQUIRED' } });
    const fresh = await factory.signedInContext(manager);
    await expect(services.staff.deactivate({ ...fresh, inspectedBy: admin.userId }, staff.profileId!)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(services.panel.setMaintenanceMode({ organisationId: admin.organisationId, workspaceId: null, userId: admin.userId, role: '' }, { enabled: true, reason: 'service-direct probe' })).rejects.toMatchObject({ response: { code: 'STEP_UP_REQUIRED' } });
    const [{ status }] = await owner.query(`SELECT status FROM core."user" WHERE id = $1`, [staff.userId]);
    expect(status).toBe('active');
    // A grant of ANOTHER user's session never satisfies (grant is bound to user AND session).
    const adminFresh = await factory.signedInContext(admin);
    await expect(stepUp.assertRecentStepUp({ ...base, sessionId: adminFresh.sessionId })).rejects.toMatchObject({ response: { code: 'STEP_UP_REQUIRED' } });
  });

  it('platform-admin grant (formerly a legacy password site, now step-up): an enrolled platform admin needs THIS session\'s step-up WITH the code; an inline password is refused', async () => {
    // Admin panel follow-up (B3): the route no longer takes `currentPassword` (400 under forbidNonWhitelisted); it requires
    // a recent step-up of this session that included the actor's code because the actor is enrolled.
    overrides.AUTH_STEP_UP_MFA_FOR_LEGACY_ACTIONS = true;
    const { managers } = await factory.createOrganisationWithManagers(1, { permissions: 'production', workspace: true, label: 'ldsulg', firstIsPlatformAdmin: true });
    const pa = managers[0]!;
    const target = (await factory.createOrganisationWithManagers(1, { permissions: 'production', label: 'ldsulgt' })).managers[0]!;
    const setup = await factory.login(pa, { applicationTarget: 'manager_web' });
    const started = await http().post('/rest/v1/auth/mfa/enrolment').set(bearer(setup)).send({ currentPassword: pa.password });
    const secret = secretFromOtpauth(started.body.otpauthUri);
    expect((await http().post('/rest/v1/auth/mfa/enrolment/confirm').set(bearer(setup)).send({ code: codeAt(secret, -1) })).status).toBe(200);
    const inline = await http().post(`/rest/v1/admin/platform-admins/${target.userId}`).set(bearer(setup)).send({ currentPassword: pa.password, reason: 'legacy body' });
    expect(inline.status).toBe(400);
    const missing = await http().post(`/rest/v1/admin/platform-admins/${target.userId}`).set(bearer(setup)).send({ reason: 'needs the code' });
    expect(missing.status).toBe(403);
    expect(missing.body).toMatchObject({ code: 'STEP_UP_REQUIRED', mfa: true });
    expect((await stepUpWith(setup, { currentPassword: pa.password, code: codeAt(secret, 0) })).status).toBe(200);
    const granted = await http().post(`/rest/v1/admin/platform-admins/${target.userId}`).set(bearer(setup)).send({ reason: 'stepped up with code' });
    expect([200, 201]).toContain(granted.status);
    await owner.query(`DELETE FROM core.platform_admin WHERE user_id = $1`, [target.userId]);
  });
});
