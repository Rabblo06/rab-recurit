import 'reflect-metadata';
import { PermissionFlag, PermissionFlagType, ShiftStatus } from '@rab/shared';
import { BadRequestException, ConflictException, ForbiddenException, INestApplication, NotFoundException, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { AppModule } from '../../app.module';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { AuthContext } from '../../engine/core-modules/tenant/auth-context.interface';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { NOTE_BODY_MAX_LENGTH } from '../../modules/identity/dto/add-note.dto';
import { ManagerService } from '../../modules/manager/services/manager.service';
import { VenueManagerService } from '../../modules/manager/services/venue-manager.service';
import { SchedulingService } from '../../modules/scheduling/services/scheduling.service';
import { StaffService } from '../../modules/staff/services/staff.service';
import { VenueService } from '../../modules/venue/services/venue.service';
import { createAdminDataSource } from './helpers/admin-datasource';
import { TestIdentity, TestIdentityFactory } from './helpers/test-identities';

/**
 * Phase 5a domain regressions, in the layer-2 hardening style (LAYER2_HARDENING_2026-10-25): every call goes to the
 * SERVICE directly — the way the AI proposal executor, a job or another service reaches it, with no route guard in the
 * path — and the "lacks the flag" actor is the SAME owner with a real per-user `revoke` override for that one flag.
 *   - T5-M1: `SchedulingService.updateDraftTx` refuses a non-DRAFT, an archived and a foreign shift; it never changes
 *     `status`, `pay_rate_pence` or `charge_rate_pence`. The console route `PATCH /shifts/:id/draft` takes no status/pay.
 *   - T5-M2: `updateDraft`, `createDraftTx` and `addNoteTx` called without their flag → 403, nothing written.
 *   - ManagerService.addNote (follow-up gap): each route's OWN flag (MANAGER_MANAGE for /managers, VENUE_MANAGER_CREATE
 *     for /venue-managers), 2,000-character cap, `manager.note_added` audit row with { noteId, length } only.
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;

describeIfDb('Phase 5a domain: updateDraft, Tx extractions and ManagerService.addNote (integration)', () => {
  jest.setTimeout(240_000);

  let app: INestApplication;
  let admin: DataSource;
  let factory: TestIdentityFactory;
  let tenantContext: TenantContextService;
  let scheduling: SchedulingService;
  let staff: StaffService;
  let managers: ManagerService;
  let venueManagers: VenueManagerService;
  let orgId: string;
  let a: TestIdentity; // owning Internal Manager (production permissions)
  let ceo: TestIdentity;
  let ctxA: AuthContext;
  let venueId: string;
  let jobRoleId: string;

  const ctxOf = (id: TestIdentity): AuthContext => ({ organisationId: id.organisationId, workspaceId: id.workspaceId, userId: id.userId, role: '' });
  const http = () => request(app.getHttpServer());
  const bump = (id: TestIdentity) => admin.query(`UPDATE core."user" SET security_version = security_version + 1 WHERE id = $1`, [id.userId]);
  async function withRevoked<T>(id: TestIdentity, flag: PermissionFlagType, fn: () => Promise<T>): Promise<T> {
    await admin.query(`INSERT INTO core.user_permission_override (user_id, permission_id, organisation_id, effect) SELECT $1, id, $2, 'revoke' FROM core.permission WHERE key = $3`, [
      id.userId,
      id.organisationId,
      flag,
    ]);
    await bump(id);
    try {
      return await fn();
    } finally {
      await admin.query(`DELETE FROM core.user_permission_override WHERE user_id = $1 AND permission_id = (SELECT id FROM core.permission WHERE key = $2)`, [id.userId, flag]);
      await bump(id);
    }
  }
  const window = (days = 6, hours = 4) => {
    const start = new Date(Date.now() + days * 86_400_000);
    return { startsAt: start.toISOString(), endsAt: new Date(start.getTime() + hours * 3_600_000).toISOString() };
  };
  const shiftRow = async (id: string) =>
    (await admin.query(`SELECT status, required_count, notes, break_minutes, pay_rate_pence, charge_rate_pence, starts_at, ends_at FROM core.shift WHERE id = $1`, [id]))[0];
  const audit = (action: string, entityId: string) =>
    admin.query(`SELECT actor_user_id, target_user_id, entity_type, metadata FROM core.audit_log WHERE organisation_id = $1 AND action = $2 AND entity_id = $3`, [orgId, action, entityId]) as Promise<
      Array<{ actor_user_id: string; target_user_id: string | null; entity_type: string; metadata: Record<string, unknown> }>
    >;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    admin = createAdminDataSource();
    await admin.initialize();
    tenantContext = moduleRef.get(TenantContextService);
    factory = new TestIdentityFactory({ app, dataSource: moduleRef.get(DataSource), adminDataSource: admin, tenantContext, passwordHashing: moduleRef.get(PasswordHashingService) });
    scheduling = moduleRef.get(SchedulingService);
    staff = moduleRef.get(StaffService);
    managers = moduleRef.get(ManagerService);
    venueManagers = moduleRef.get(VenueManagerService);
    const seeded = await factory.createOrganisationWithManagers(1, { permissions: 'production', workspace: true, label: 'p5dom' });
    orgId = seeded.organisation.id;
    a = seeded.managers[0]!;
    ctxA = ctxOf(a);
    ceo = await factory.createCeo(seeded.organisation, { permissions: 'production' });
    venueId = (await moduleRef.get(VenueService).create(ctxA, { name: `P5 Venue ${randomUUID().slice(0, 6)}`, type: 'hotel' } as never)).id;
    jobRoleId = (await scheduling.createJobRole(ctxA, { name: `P5 Role ${randomUUID().slice(0, 6)}`, defaultRatePence: 1400 } as never)).id;
  });

  afterAll(async () => {
    await app?.close();
    await admin?.destroy();
  });

  // ─────────────────────────────────────────── T5-M1 updateDraft

  describe('T5-M1 SchedulingService.updateDraft / updateDraftTx', () => {
    it('changes only the named fields of a DRAFT; status, pay and charge stay; audited with field names only', async () => {
      const draft = await scheduling.create(ctxA, { venueId, jobRoleId, ...window(), requiredCount: 1, payRatePence: 1777, chargeRatePence: 2500 } as never);
      const next = window(7, 5);
      const updated = await scheduling.updateDraft(ctxA, draft.id, { ...next, requiredCount: 3, notes: 'Bring ID', breakMinutes: 30 });
      expect(updated.status).toBe(ShiftStatus.DRAFT);
      const row = await shiftRow(draft.id);
      expect(row).toMatchObject({ status: 'draft', required_count: 3, notes: 'Bring ID', break_minutes: 30, pay_rate_pence: '1777', charge_rate_pence: '2500' });
      expect(new Date(row.starts_at).toISOString()).toBe(next.startsAt);
      const [entry] = await audit('shift.draft_updated', draft.id);
      expect(entry!.metadata).toEqual({ fields: ['startsAt', 'endsAt', 'breakMinutes', 'requiredCount', 'notes'] });
      expect(JSON.stringify(entry)).not.toContain('Bring ID');
      await scheduling.updateDraft(ctxA, draft.id, { notes: null });
      expect((await shiftRow(draft.id)).notes).toBeNull();
    });

    it('refuses a published shift (409), an archived draft (409), a foreign / unknown shift (404), a bad window and no fields (400)', async () => {
      const published = await scheduling.create(ctxA, { venueId, jobRoleId, ...window(), requiredCount: 1 } as never);
      await scheduling.publish(ctxA, published.id);
      await expect(scheduling.updateDraft(ctxA, published.id, { requiredCount: 2 })).rejects.toBeInstanceOf(ConflictException);
      expect((await shiftRow(published.id)).status).toBe('open');

      const archived = await scheduling.create(ctxA, { venueId, jobRoleId, ...window(), requiredCount: 1 } as never);
      await scheduling.archiveShift(ctxA, archived.id);
      await expect(scheduling.updateDraft(ctxA, archived.id, { requiredCount: 2 })).rejects.toBeInstanceOf(ConflictException);

      const other = await factory.createInternalManager({ id: orgId }, { permissions: 'production' });
      const mine = await scheduling.create(ctxA, { venueId, jobRoleId, ...window(), requiredCount: 1 } as never);
      await expect(scheduling.updateDraft(ctxOf(other), mine.id, { requiredCount: 2 })).rejects.toBeInstanceOf(NotFoundException);
      await expect(scheduling.updateDraft(ctxA, randomUUID(), { requiredCount: 2 })).rejects.toBeInstanceOf(NotFoundException);
      const w = window();
      await expect(scheduling.updateDraft(ctxA, mine.id, { endsAt: new Date(new Date(mine.startsAt).getTime() - 60_000).toISOString() })).rejects.toBeInstanceOf(BadRequestException);
      await expect(scheduling.updateDraft(ctxA, mine.id, {})).rejects.toBeInstanceOf(BadRequestException);
      await expect(scheduling.updateDraft(ctxA, mine.id, { requiredCount: 0 })).rejects.toBeInstanceOf(BadRequestException);
      expect((await shiftRow(mine.id)).required_count).toBe(1);
      expect(w).toBeDefined();
    });

    it('HTTP PATCH /shifts/:id/draft: 200 for the five fields; status / pay / venue / organisationId in the body → 400', async () => {
      const token = await factory.login(a);
      const draft = await scheduling.create(ctxA, { venueId, jobRoleId, ...window(), requiredCount: 1 } as never);
      const patch = (body: object) => http().patch(`/rest/v1/shifts/${draft.id}/draft`).set('Authorization', `Bearer ${token}`).send(body);
      for (const body of [{ status: 'open' }, { payRatePence: 1 }, { chargeRatePence: 1 }, { venueId }, { organisationId: orgId }, { requiredCount: 2, status: 'draft' }]) {
        expect({ body, status: (await patch(body)).status }).toEqual({ body, status: 400 });
      }
      const ok = await patch({ requiredCount: 2 });
      expect(ok.status).toBe(200);
      expect(ok.body).toMatchObject({ id: draft.id, status: 'draft', requiredCount: 2 });
      await withRevoked(a, PermissionFlag.SCHEDULE_CREATE, async () => {
        expect((await patch({ requiredCount: 3 })).status).toBe(403);
      });
    });
  });

  // ─────────────────────────────────────────── T5-M2 direct calls without the flag

  describe('T5-M2 direct service calls without the flag → 403, nothing written', () => {
    it('updateDraft / updateDraftTx without SCHEDULE_CREATE (own draft and unknown id alike)', async () => {
      const draft = await scheduling.create(ctxA, { venueId, jobRoleId, ...window(), requiredCount: 1 } as never);
      await withRevoked(a, PermissionFlag.SCHEDULE_CREATE, async () => {
        await expect(scheduling.updateDraft(ctxA, draft.id, { requiredCount: 5 })).rejects.toBeInstanceOf(ForbiddenException);
        await expect(scheduling.updateDraft(ctxA, randomUUID(), { requiredCount: 5 })).rejects.toBeInstanceOf(ForbiddenException);
        await expect(tenantContext.runInWorkspaceContext(ctxA, (m) => scheduling.updateDraftTx(m, ctxA, draft.id, { requiredCount: 5 }))).rejects.toBeInstanceOf(ForbiddenException);
        await expect(tenantContext.runInWorkspaceContext(ctxA, (m) => scheduling.createDraftTx(m, ctxA, { venueId, jobRoleId, ...window(), requiredCount: 1 } as never))).rejects.toBeInstanceOf(
          ForbiddenException,
        );
      });
      expect((await shiftRow(draft.id)).required_count).toBe(1);
      expect(await audit('shift.draft_updated', draft.id)).toHaveLength(0);
    });

    it('StaffService.addNoteTx without STAFF_EDIT → 403, no note', async () => {
      const member = await factory.createStaff({ id: orgId }, { owner: a, label: 'p5note' });
      await withRevoked(a, PermissionFlag.STAFF_EDIT, async () => {
        await expect(tenantContext.runInWorkspaceContext(ctxA, (m) => staff.addNoteTx(m, ctxA, member.profileId!, { body: 'never lands' }))).rejects.toBeInstanceOf(ForbiddenException);
      });
      expect((await admin.query(`SELECT count(*)::int AS n FROM core.user_note WHERE subject_user_id = $1`, [member.userId]))[0].n).toBe(0);
    });
  });

  // ─────────────────────────────────────────── ManagerService.addNote (two routes, two flags)

  describe('ManagerService.addNote: the flag of each route, cap and audit', () => {
    const notes = (userId: string) => admin.query(`SELECT count(*)::int AS n FROM core.user_note WHERE subject_user_id = $1`, [userId]).then((r) => r[0].n as number);

    it('/managers path (MANAGER_MANAGE): a direct call without the flag → 403 before any lookup, nothing written', async () => {
      const target = await factory.createInternalManager({ id: orgId }, { permissions: 'production' });
      const before = await notes(target.userId);
      await withRevoked(ceo, PermissionFlag.MANAGER_MANAGE, async () => {
        await expect(managers.addNote(ctxOf(ceo), target.profileId!, { body: 'no' })).rejects.toBeInstanceOf(ForbiddenException);
        await expect(managers.addNote(ctxOf(ceo), randomUUID(), { body: 'no' })).rejects.toBeInstanceOf(ForbiddenException);
      });
      // An Internal Manager holds VENUE_MANAGER_CREATE but not MANAGER_MANAGE: the /managers path stays closed to them.
      await expect(managers.addNote(ctxA, target.profileId!, { body: 'no' })).rejects.toBeInstanceOf(ForbiddenException);
      expect(await notes(target.userId)).toBe(before);
      expect(await audit('manager.note_added', target.profileId!)).toHaveLength(0);
    });

    it('/venue-managers path (VENUE_MANAGER_CREATE): a direct call without the flag → 403; a Venue Manager outside the caller’s workspace → 404', async () => {
      const vm = await factory.createVenueManager({ id: orgId }, { owner: a, label: 'p5vm' });
      await withRevoked(a, PermissionFlag.VENUE_MANAGER_CREATE, async () => {
        await expect(venueManagers.addNote(ctxA, vm.profileId!, { body: 'no' })).rejects.toBeInstanceOf(ForbiddenException);
        await expect(managers.addNote(ctxA, vm.profileId!, { body: 'no' }, PermissionFlag.VENUE_MANAGER_CREATE)).rejects.toBeInstanceOf(ForbiddenException);
      });
      const otherOwner = await factory.createInternalManager({ id: orgId }, { permissions: 'production' });
      const foreignVm = await factory.createVenueManager({ id: orgId }, { owner: otherOwner, label: 'p5vmx' });
      await expect(venueManagers.addNote(ctxA, foreignVm.profileId!, { body: 'no' })).rejects.toBeInstanceOf(NotFoundException);
      expect(await notes(vm.userId)).toBe(0);
      expect(await notes(foreignVm.userId)).toBe(0);
      // Any other flag is refused outright (fail closed), whatever the caller holds.
      await expect(managers.addNote(ctxOf(ceo), vm.profileId!, { body: 'no' }, PermissionFlag.STAFF_EDIT as never)).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('over-length / empty body via the service → 400, nothing written', async () => {
      const target = await factory.createInternalManager({ id: orgId }, { permissions: 'production' });
      await expect(managers.addNote(ctxOf(ceo), target.profileId!, { body: 'x'.repeat(NOTE_BODY_MAX_LENGTH + 1) })).rejects.toBeInstanceOf(BadRequestException);
      await expect(managers.addNote(ctxOf(ceo), target.profileId!, { body: '' })).rejects.toBeInstanceOf(BadRequestException);
      expect(await notes(target.userId)).toBe(0);
    });

    it('both routes still work with their own flag; audited manager.note_added with { noteId, length } only', async () => {
      const target = await factory.createInternalManager({ id: orgId }, { permissions: 'production' });
      const vm = await factory.createVenueManager({ id: orgId }, { owner: a, label: 'p5vmok' });
      const ceoToken = await factory.login(ceo);
      const mgrToken = await factory.login(a);
      const secret = `Manager note ${randomUUID()}`;
      const viaManagers = await http().post(`/rest/v1/managers/${target.profileId}/notes`).set('Authorization', `Bearer ${ceoToken}`).send({ body: secret });
      expect(viaManagers.status).toBe(201);
      const viaVenueManagers = await http().post(`/rest/v1/venue-managers/${vm.profileId}/notes`).set('Authorization', `Bearer ${mgrToken}`).send({ body: secret });
      expect(viaVenueManagers.status).toBe(201);
      // The guard on /managers still answers first for a caller without MANAGER_MANAGE.
      expect((await http().post(`/rest/v1/managers/${target.profileId}/notes`).set('Authorization', `Bearer ${mgrToken}`).send({ body: secret })).status).toBe(403);
      for (const [profileId, actor, noteId, subject] of [
        [target.profileId!, ceo.userId, viaManagers.body.id, target.userId],
        [vm.profileId!, a.userId, viaVenueManagers.body.id, vm.userId],
      ] as const) {
        const rows = await audit('manager.note_added', profileId);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ actor_user_id: actor, target_user_id: subject, entity_type: 'manager_profile', metadata: { noteId, length: secret.length } });
        expect(Object.keys(rows[0]!.metadata).sort()).toEqual(['length', 'noteId']);
        expect(JSON.stringify(rows[0])).not.toContain(secret);
      }
    });
  });
});
