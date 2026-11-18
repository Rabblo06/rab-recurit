import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../../app.module';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { AuthContext, AuthSecuritySnapshot } from '../../engine/core-modules/tenant/auth-context.interface';
import { ShiftTeamService } from '../../modules/attendance/services/shift-team.service';
import { createAdminDataSource } from './helpers/admin-datasource';
import { TestIdentity, TestIdentityFactory } from './helpers/test-identities';
import { businessTable } from './helpers/hws-fixtures';
import { applyGlobalValidationPipe } from '../../engine/utils/global-validation-pipe';
import { businessTables } from '../../engine/core-modules/tenant/business-tables';

describe('Staff same-shift Teams (real Postgres/RLS/HTTP)', () => {
  jest.setTimeout(180000);
  let app: INestApplication, owner: DataSource, tenant: TenantContextService;
  let factory: TestIdentityFactory, manager: TestIdentity, otherManager: TestIdentity;
  let caller: TestIdentity, peer: TestIdentity, outsider: TestIdentity, foreign: TestIdentity;
  let shift: string, callerToken: string, peerAssignment: string;
  let service: ShiftTeamService;
  let org: Awaited<ReturnType<TestIdentityFactory['createOrganisationWithManagers']>>['organisation'];
  /** The server-resolved role list JwtAuthGuard attaches (only `roles` is read by the staff check). */
  const snapshot = (roles: string[]) => ({ roles }) as unknown as AuthSecuritySnapshot;
  /** A live shift at a new venue with the given staff confirmed on it. */
  const seedShift = async (people: TestIdentity[]): Promise<string> => {
    const id = randomUUID();
    await tenant.runInWorkspaceContext(ctx(manager), async m => {
      const venue = randomUUID(), role = randomUUID();
      await m.query(`INSERT INTO ${businessTables(m).venue}(id,organisation_id,workspace_id,name,created_by) VALUES ($1,$2,$3,'Roster venue 2',$4)`, [venue, manager.organisationId, manager.workspaceId, manager.userId]);
      await m.query(`INSERT INTO ${businessTables(m).job_role}(id,organisation_id,workspace_id,name) VALUES ($1,$2,$3,'Roster role 2')`, [role, manager.organisationId, manager.workspaceId]);
      await m.query(`INSERT INTO ${businessTables(m).shift}(id,organisation_id,workspace_id,venue_id,job_role_id,starts_at,ends_at,required_count,filled_count,pay_rate_pence,status,created_by)
        VALUES ($1,$2,$3,$4,$5,'2030-11-02T22:00:00Z','2030-11-03T07:00:00Z',3,$6,1200,'confirmed',$7)`,
        [id, manager.organisationId, manager.workspaceId, venue, role, people.length, manager.userId]);
      for (const person of people) {
        await m.query(`INSERT INTO ${businessTables(m).shift_assignment}(id,organisation_id,workspace_id,shift_id,staff_profile_id,status,pay_rate_snapshot_pence,assigned_by,period)
          VALUES ($1,$2,$3,$4,$5,'confirmed',1200,$6,tstzrange('2030-11-02T22:00:00Z','2030-11-03T07:00:00Z','[)'))`,
          [randomUUID(), manager.organisationId, manager.workspaceId, id, person.profileId, manager.userId]);
      }
    });
    return id;
  };
  const ctx = (id: TestIdentity): AuthContext => ({ organisationId: id.organisationId, workspaceId: id.workspaceId,
    userId: id.userId, role: id.roleKey, applicationTarget: id.defaultApplication });
  const roster = (token: string, id = shift) => request(app.getHttpServer()).get(`/rest/v1/attendance/me/shift/${id}/team`).set('Authorization', `Bearer ${token}`);

  beforeAll(async () => {
    const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = applyGlobalValidationPipe(module.createNestApplication());
    await app.init();
    owner = createAdminDataSource(); await owner.initialize();
    tenant = module.get(TenantContextService); service = module.get(ShiftTeamService);
    factory = new TestIdentityFactory({ app, dataSource: module.get(DataSource), adminDataSource: owner,
      tenantContext: tenant, passwordHashing: module.get(PasswordHashingService) });
    const seeded = await factory.createOrganisationWithManagers(2, { permissions: 'production', workspace: true });
    [manager, otherManager] = seeded.managers;
    org = seeded.organisation;
    caller = await factory.createStaff(seeded.organisation, { owner: manager });
    peer = await factory.createStaff(seeded.organisation, { owner: manager });
    outsider = await factory.createStaff(seeded.organisation, { owner: manager });
    foreign = await factory.createStaff(seeded.organisation, { owner: otherManager });
    shift = randomUUID(); peerAssignment = randomUUID();
    await tenant.runInWorkspaceContext(ctx(manager), async m => {
      const venue = randomUUID(), role = randomUUID();
      await m.query(`INSERT INTO ${businessTables(m).venue}(id,organisation_id,workspace_id,name,created_by) VALUES ($1,$2,$3,'Roster venue',$4)`, [venue, manager.organisationId, manager.workspaceId, manager.userId]);
      await m.query(`INSERT INTO ${businessTables(m).job_role}(id,organisation_id,workspace_id,name) VALUES ($1,$2,$3,'Roster role')`, [role, manager.organisationId, manager.workspaceId]);
      await m.query(`INSERT INTO ${businessTables(m).shift}(id,organisation_id,workspace_id,venue_id,job_role_id,starts_at,ends_at,required_count,filled_count,pay_rate_pence,status,created_by)
        VALUES ($1,$2,$3,$4,$5,'2030-10-26T22:00:00Z','2030-10-27T07:00:00Z',3,2,1200,'confirmed',$6)`,
        [shift, manager.organisationId, manager.workspaceId, venue, role, manager.userId]);
      for (const [person, id, status] of [[caller, randomUUID(), 'confirmed'], [peer, peerAssignment, 'confirmed'], [outsider, randomUUID(), 'offered']] as const) {
        await m.query(`INSERT INTO ${businessTables(m).shift_assignment}(id,organisation_id,workspace_id,shift_id,staff_profile_id,status,pay_rate_snapshot_pence,assigned_by,period)
          VALUES ($1,$2,$3,$4,$5,$6,1200,$7,tstzrange('2030-10-26T22:00:00Z','2030-10-27T07:00:00Z','[)'))`,
          [id, manager.organisationId, manager.workspaceId, shift, person.profileId, status, manager.userId]);
      }
    });
    callerToken = await factory.login(caller);
  });
  afterAll(async () => { await owner?.destroy(); await app?.close(); });

  it('returns only confirmed names, individual intervals and You; no IDs, contact, pay or attendance', async () => {
    const result = await roster(callerToken);
    expect(result.status).toBe(200);
    expect(result.body).toHaveLength(2);
    expect(result.body.filter((r: { isYou: boolean }) => r.isYou)).toHaveLength(1);
    for (const row of result.body) {
      expect(Object.keys(row).sort()).toEqual(['displayName', 'endsAt', 'isYou', 'startsAt']);
      expect(row.startsAt).toBe('2030-10-26T22:00:00.000Z');
      expect(row.endsAt).toBe('2030-10-27T07:00:00.000Z');
    }
  });
  it('denies unconfirmed caller and a different workspace', async () => {
    expect((await roster(await factory.login(outsider))).status).toBe(404);
    expect((await roster(await factory.login(foreign))).status).toBe(404);
  });
  it('denies unrelated shift IDs without enumeration', async () => {
    const unrelated = await roster(callerToken, randomUUID());
    expect(unrelated.status).toBe(404);
    // A malformed `:shiftId` is a record identifier that can name no record: the global UuidPathParamsInterceptor
    // answers 404 before the route's ParseUUIDPipe runs (interceptors precede pipes) — the repo-wide convention
    // pinned by path-param-uuid-validation.integration.spec.ts. (Its generic 'Not found.' message reveals only what the
    // caller already knows — that the id is malformed — never whether some shift exists.)
    const malformed = await roster(callerToken, 'invalid');
    expect(malformed.status).toBe(404);
  });
  it('denies another organisation', async () => {
    const seeded = await factory.createOrganisationWithManagers(1, { permissions: 'production', workspace: true });
    const actor = await factory.createStaff(seeded.organisation, { owner: seeded.managers[0] });
    expect((await roster(await factory.login(actor))).status).toBe(404);
  });
  it('denies unauthenticated and Manager app access', async () => {
    expect((await request(app.getHttpServer()).get(`/rest/v1/attendance/me/shift/${shift}/team`)).status).toBe(401);
    expect((await roster(await factory.login(manager))).status).toBe(403);
    await expect(service.list({ ...ctx(caller), applicationTarget: 'manager_web' }, shift)).rejects.toThrow('Staff attendance access required');
  });
  // Role MEMBERSHIP, not equality on the comma-joined `ctx.role` (which refused every staff user holding another role).
  it('service layer: a single-role staff caller on the staff app gets the roster', async () => {
    const rows = await service.list({ ...ctx(caller), security: snapshot(['staff']) }, shift);
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.isYou)).toHaveLength(1);
  });
  it('service layer: a caller without the staff role is refused even on the staff app (layer 2, no guard involved)', async () => {
    await expect(service.list({ ...ctx(caller), role: 'manager', security: snapshot(['manager']) }, shift)).rejects.toThrow('Staff attendance access required');
    await expect(service.list({ ...ctx(caller), role: 'manager,venue_manager', security: snapshot(['manager', 'venue_manager']) }, shift)).rejects.toThrow('Staff attendance access required');
  });
  it('service layer: no server-resolved roles (a caller that bypassed JwtAuthGuard) is refused, fail closed', async () => {
    await expect(service.list(ctx(caller), shift)).rejects.toThrow('Staff attendance access required');
  });
  it('a non-staff identity signed in to the staff app is refused (403)', async () => {
    expect((await roster(await factory.login(manager, { applicationTarget: 'staff_app' }))).status).toBe(403);
  });
  describe('a staff user who also holds another role', () => {
    let multi: TestIdentity, multiShift: string, multiToken: string;
    beforeAll(async () => {
      multi = await factory.createStaff(org, { owner: manager });
      const mate = await factory.createStaff(org, { owner: manager });
      multiShift = await seedShift([multi, mate]);
      // A second system role on the same user: the session's roles are then ['manager', 'staff'] (ctx.role 'manager,staff').
      await owner.query(
        `INSERT INTO core.user_role (user_id, role_id, organisation_id)
         SELECT $1, id, organisation_id FROM core.role WHERE organisation_id = $2 AND key = 'manager'`,
        [multi.userId, multi.organisationId],
      );
      multiToken = await factory.login(multi, { applicationTarget: 'staff_app' });
    });
    it('passes the staff check and reads the roster (was 403)', async () => {
      const result = await roster(multiToken, multiShift);
      expect(result.status).toBe(200);
      expect(result.body.filter((r: { isYou: boolean }) => r.isYou)).toHaveLength(1);
    });
    // Layer 4 (structure level 24, StaffShiftTeamMultiRole1786721590000; DRAFT SQL, owner review first): the RLS policy
    // staff_profile_shift_team_select now tests `'staff' = ANY (string_to_array(rab.role, ','))` instead of equality, so the
    // database shows this caller every confirmed teammate, like a single-role staff user (was: only "You").
    it('sees the whole confirmed team, like a single-role staff user', async () => {
      const result = await roster(multiToken, multiShift);
      expect(result.status).toBe(200);
      expect(result.body).toHaveLength(2);
      expect(result.body.filter((r: { isYou: boolean }) => r.isYou)).toHaveLength(1);
    });
  });
  it('does not widen ordinary Staff profile visibility, including after a pooled roster read', async () => {
    await roster(callerToken);
    const rows = await tenant.runInWorkspaceContext(ctx(caller), m => m.query(`SELECT id FROM ${businessTables(m).staff_profile}`));
    expect(rows.map((r: { id: string }) => r.id)).toEqual([caller.profileId]);
    const none = await tenant.runInTenantContext({ ...ctx(caller), organisationId: null, workspaceId: null }, m => m.query('SELECT id FROM core.staff_profile'));
    expect(none).toEqual([]);
  });
  it.each(['cancelled', 'declined', 'offered', 'completed'])('excludes %s assignments immediately', async status => {
    await tenant.runInWorkspaceContext(ctx(manager), m => m.query(`UPDATE ${businessTables(m).shift_assignment} SET status=$1 WHERE id=$2`, [status, peerAssignment]));
    try {
      const result = await roster(callerToken);
      expect(result.status).toBe(200); expect(result.body).toHaveLength(1);
    } finally {
      await tenant.runInWorkspaceContext(ctx(manager), m => m.query(`UPDATE ${businessTables(m).shift_assignment} SET status='confirmed' WHERE id=$1`, [peerAssignment]));
    }
  });
  it('uses updated individual assignment intervals', async () => {
    await tenant.runInWorkspaceContext(ctx(manager), m => m.query(`UPDATE ${businessTables(m).shift_assignment} SET period=tstzrange('2030-10-27T01:00:00Z','2030-10-27T06:00:00Z','[)') WHERE id=$1`, [peerAssignment]));
    const result = await roster(callerToken);
    expect(result.body.find((r: { isYou: boolean }) => !r.isYou).startsAt).toBe('2030-10-27T01:00:00.000Z');
  });
  it('denies a caller removed from the shift on the next read', async () => {
    await tenant.runInWorkspaceContext(ctx(manager), m => m.query(`UPDATE ${businessTables(m).shift_assignment} SET status='withdrawn' WHERE shift_id=$1 AND staff_profile_id=$2`, [shift, caller.profileId]));
    try { expect((await roster(callerToken)).status).toBe(404); }
    finally {
      await tenant.runInWorkspaceContext(ctx(manager), m => m.query(`UPDATE ${businessTables(m).shift_assignment} SET status='confirmed' WHERE shift_id=$1 AND staff_profile_id=$2`, [shift, caller.profileId]));
    }
  });
  it('waits for concurrent cancellation, then denies the roster', async () => {
    const runner = owner.createQueryRunner(); await runner.connect(); await runner.startTransaction();
    try {
      await runner.query(`SELECT set_config('rab.organisation_id',$1,true),set_config('rab.workspace_id',$2,true)`, [manager.organisationId, manager.workspaceId]);
      await runner.query(`UPDATE ${businessTable(manager.workspaceId!, 'shift')} SET status='cancelled' WHERE id=$1`, [shift]);
      const pending = roster(callerToken).then(r => r);
      await runner.commitTransaction();
      expect((await pending).status).toBe(404);
    } finally { if (runner.isTransactionActive) await runner.rollbackTransaction(); await runner.release(); }
  });
});
