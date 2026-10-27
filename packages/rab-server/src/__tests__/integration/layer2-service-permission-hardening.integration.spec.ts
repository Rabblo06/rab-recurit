import 'reflect-metadata';
import { PermissionFlag, PermissionFlagType, ShiftStatus } from '@rab/shared';
import { BadRequestException, ForbiddenException, INestApplication, NotFoundException, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { AppModule } from '../../app.module';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { AuthContext } from '../../engine/core-modules/tenant/auth-context.interface';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { NOTE_BODY_MAX_LENGTH } from '../../modules/identity/dto/add-note.dto';
import { SchedulingService } from '../../modules/scheduling/services/scheduling.service';
import { StaffService } from '../../modules/staff/services/staff.service';
import { VenueService } from '../../modules/venue/services/venue.service';
import { createAdminDataSource } from './helpers/admin-datasource';
import { TestIdentity, TestIdentityFactory } from './helpers/test-identities';

/**
 * LAYER2_HARDENING_2026-10-25 (docs/security/) — abuse cases for the layer-2 (service) permission checks added to
 * VenueService.list/get (VENUE_VIEW), SchedulingService.create (SCHEDULE_CREATE) / publish (SCHEDULE_PUBLISH) and
 * StaffService.addNote (STAFF_EDIT, 2,000-character cap, `staff.note_added` audit row).
 *
 * Every call here goes to the SERVICE directly — never through HTTP, so the route's PermissionGuard is NOT in the
 * path — exactly how a job, CLI command or another service reaches it. The "lacks the flag" actor is the SAME owning
 * Internal Manager with a real per-user `revoke` override for that one flag (`core.user_permission_override`, the
 * row `PermissionsService.userHasPermissionTx` already honours): same workspace, same records, only the flag
 * differs, so a refusal can only come from the new check. Real PostgreSQL with RLS on (crewflow_app), no mocks.
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;

describeIfDb('layer-2 service permission hardening (integration)', () => {
  jest.setTimeout(240_000);

  let app: INestApplication;
  let admin: DataSource;
  let factory: TestIdentityFactory;
  let tenantContext: TenantContextService;
  let venues: VenueService;
  let scheduling: SchedulingService;
  let staff: StaffService;
  let orgId: string;
  let a: TestIdentity; // owning Internal Manager, production permission set
  let staffMember: TestIdentity; // staff in a's workspace
  let ctxA: AuthContext;
  let venueId: string;
  let jobRoleId: string;

  const uniq = (label: string) => `${label} ${randomUUID().slice(0, 8)}`;
  const ctxOf = (identity: TestIdentity): AuthContext => ({ organisationId: identity.organisationId, workspaceId: identity.workspaceId, userId: identity.userId, role: 'manager' });

  /**
   * Runs `fn` while `flag` is revoked for `identity` by a per-user override; the override is removed afterwards, whatever
   * happens. No production service writes overrides yet, so — exactly as auth-security-snapshot.integration.spec.ts
   * does — `user.security_version` is bumped with each write: that is what invalidates the cached per-request security
   * snapshot the HTTP guard reads (the service-level check reads the override table directly and needs no bump).
   */
  async function withRevoked<T>(identity: TestIdentity, flag: PermissionFlagType, fn: () => Promise<T>): Promise<T> {
    const inserted = (await admin.query(
      `INSERT INTO core.user_permission_override (user_id, permission_id, organisation_id, effect)
       SELECT $1, id, $2, 'revoke' FROM core.permission WHERE key = $3 RETURNING user_id`,
      [identity.userId, identity.organisationId, flag],
    )) as unknown[];
    if (inserted.length !== 1) throw new Error(`test setup: permission ${flag} is not in the catalogue`);
    await bumpSecurityVersion(identity);
    try {
      return await fn();
    } finally {
      await admin.query(
        `DELETE FROM core.user_permission_override WHERE user_id = $1 AND permission_id = (SELECT id FROM core.permission WHERE key = $2)`,
        [identity.userId, flag],
      );
      await bumpSecurityVersion(identity);
    }
  }

  const bumpSecurityVersion = (identity: TestIdentity) =>
    admin.query(`UPDATE core."user" SET security_version = security_version + 1 WHERE id = $1`, [identity.userId]);

  const auditRows = async (action: string, where: { entityId?: string; actorUserId?: string }) =>
    (await admin.query(
      `SELECT actor_user_id, target_user_id, entity_type, entity_id, metadata FROM core.audit_log
        WHERE organisation_id = $1 AND action = $2 AND ($3::uuid IS NULL OR entity_id = $3::uuid) AND ($4::uuid IS NULL OR actor_user_id = $4::uuid)`,
      [orgId, action, where.entityId ?? null, where.actorUserId ?? null],
    )) as Array<{ actor_user_id: string; target_user_id: string | null; entity_type: string; entity_id: string; metadata: Record<string, unknown> }>;

  /** Counts through the runtime role in the caller's own workspace context (the same search_path / RLS a request gets). */
  const countInWorkspace = (sql: string, params: unknown[]) =>
    tenantContext.runInWorkspaceContext(ctxA, async (m) => Number(((await m.query(sql, params)) as Array<{ n: number }>)[0]!.n));

  const shiftDto = () => {
    const start = new Date(Date.now() + 6 * 86_400_000);
    return { venueId, jobRoleId, startsAt: start.toISOString(), endsAt: new Date(start.getTime() + 4 * 3_600_000).toISOString(), requiredCount: 1 };
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    admin = createAdminDataSource();
    await admin.initialize();
    tenantContext = moduleRef.get(TenantContextService);
    factory = new TestIdentityFactory({
      app, dataSource: moduleRef.get(DataSource), adminDataSource: admin, tenantContext, passwordHashing: moduleRef.get(PasswordHashingService),
    });
    venues = moduleRef.get(VenueService);
    scheduling = moduleRef.get(SchedulingService);
    staff = moduleRef.get(StaffService);

    const seeded = await factory.createOrganisationWithManagers(1, { permissions: 'production', workspace: true, label: 'l2hard' });
    orgId = seeded.organisation.id;
    a = seeded.managers[0]!;
    ctxA = ctxOf(a);
    staffMember = await factory.createStaff(seeded.organisation, { owner: a, label: 'l2hard-staff' });
    venueId = (await venues.create(ctxA, { name: uniq('L2 Venue'), type: 'hotel' } as never)).id;
    jobRoleId = (await scheduling.createJobRole(ctxA, { name: uniq('L2 Role'), defaultRatePence: 1300 } as never)).id;
  });

  afterAll(async () => {
    await app?.close();
    await admin?.destroy();
  });

  // ─────────────────────────────────────────────── F1: VenueService.list / get (VENUE_VIEW)

  describe('F1 VenueService.list / get require VENUE_VIEW', () => {
    it('list(): without VENUE_VIEW → 403, no rows returned (the caller owns a venue)', async () => {
      let result: unknown;
      await withRevoked(a, PermissionFlag.VENUE_VIEW, async () => {
        await expect(
          venues.list(ctxA).then((r) => {
            result = r;
            return r;
          }),
        ).rejects.toBeInstanceOf(ForbiddenException);
      });
      expect(result).toBeUndefined();
    });

    it('get(): without VENUE_VIEW → 403 for the caller\'s OWN venue and for an unknown id alike (no existence oracle)', async () => {
      await withRevoked(a, PermissionFlag.VENUE_VIEW, async () => {
        await expect(venues.get(ctxA, venueId)).rejects.toBeInstanceOf(ForbiddenException);
        await expect(venues.get(ctxA, randomUUID())).rejects.toBeInstanceOf(ForbiddenException);
      });
    });

    it('with VENUE_VIEW: list() and get() work as before; an unknown id is still a 404', async () => {
      const listed = await venues.list(ctxA);
      expect(listed.data.map((v) => v.id)).toContain(venueId);
      expect((await venues.get(ctxA, venueId)).id).toBe(venueId);
      await expect(venues.get(ctxA, randomUUID())).rejects.toBeInstanceOf(NotFoundException);
    });

    it('HTTP behaviour is unchanged: the route guard still answers 403 first, 200 with the flag', async () => {
      const token = await factory.login(a);
      const http = () => request(app.getHttpServer());
      await withRevoked(a, PermissionFlag.VENUE_VIEW, async () => {
        expect((await http().get('/rest/v1/venues').set('Authorization', `Bearer ${token}`)).status).toBe(403);
        expect((await http().get(`/rest/v1/venues/${venueId}`).set('Authorization', `Bearer ${token}`)).status).toBe(403);
      });
      expect((await http().get(`/rest/v1/venues/${venueId}`).set('Authorization', `Bearer ${token}`)).status).toBe(200);
    });
  });

  // ─────────────────────────────────────────────── F2: SchedulingService.create / publish

  describe('F2 SchedulingService.create (SCHEDULE_CREATE) / publish (SCHEDULE_PUBLISH)', () => {
    it('create(): without SCHEDULE_CREATE → 403, no shift row and no shift.created audit row', async () => {
      const shiftsBefore = await countInWorkspace(`SELECT count(*)::int AS n FROM shift WHERE venue_id = $1`, [venueId]);
      const auditBefore = (await auditRows('shift.created', { actorUserId: a.userId })).length;
      await withRevoked(a, PermissionFlag.SCHEDULE_CREATE, async () => {
        await expect(scheduling.create(ctxA, shiftDto() as never)).rejects.toBeInstanceOf(ForbiddenException);
      });
      expect(await countInWorkspace(`SELECT count(*)::int AS n FROM shift WHERE venue_id = $1`, [venueId])).toBe(shiftsBefore);
      expect((await auditRows('shift.created', { actorUserId: a.userId })).length).toBe(auditBefore);
    });

    it('create(): without SCHEDULE_CREATE the refusal comes before the venue lookup (an unknown venue id is 403, not 404)', async () => {
      await withRevoked(a, PermissionFlag.SCHEDULE_CREATE, async () => {
        await expect(scheduling.create(ctxA, { ...shiftDto(), venueId: randomUUID() } as never)).rejects.toBeInstanceOf(ForbiddenException);
      });
    });

    it('publish(): without SCHEDULE_PUBLISH → 403, the draft stays DRAFT and no shift.published audit row', async () => {
      const draft = await scheduling.create(ctxA, shiftDto() as never);
      await withRevoked(a, PermissionFlag.SCHEDULE_PUBLISH, async () => {
        await expect(scheduling.publish(ctxA, draft.id)).rejects.toBeInstanceOf(ForbiddenException);
        await expect(scheduling.publish(ctxA, randomUUID())).rejects.toBeInstanceOf(ForbiddenException);
      });
      const [row] = (await tenantContext.runInWorkspaceContext(ctxA, (m) => m.query(`SELECT status, published_at FROM shift WHERE id = $1`, [draft.id]))) as Array<{ status: string; published_at: Date | null }>;
      expect(row).toEqual({ status: ShiftStatus.DRAFT, published_at: null });
      expect(await auditRows('shift.published', { entityId: draft.id })).toHaveLength(0);
    });

    it('with the flags: create() then publish() work as before (shift.created + shift.published audited)', async () => {
      const created = await scheduling.create(ctxA, shiftDto() as never);
      expect(created.status).toBe(ShiftStatus.DRAFT);
      expect(await auditRows('shift.created', { entityId: created.id })).toHaveLength(1);
      const published = await scheduling.publish(ctxA, created.id);
      expect(published.status).toBe(ShiftStatus.OPEN);
      expect(await auditRows('shift.published', { entityId: created.id })).toHaveLength(1);
      await expect(scheduling.publish(ctxA, randomUUID())).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ─────────────────────────────────────────────── F3: StaffService.addNote

  describe('F3 StaffService.addNote (STAFF_EDIT, length cap, audit)', () => {
    const noteCount = () => countInWorkspace(`SELECT count(*)::int AS n FROM user_note WHERE subject_user_id = $1`, [staffMember.userId]);

    it('without STAFF_EDIT → 403, no note written, no staff.note_added audit row', async () => {
      const before = await noteCount();
      await withRevoked(a, PermissionFlag.STAFF_EDIT, async () => {
        await expect(staff.addNote(ctxA, staffMember.profileId!, { body: 'should never land' })).rejects.toBeInstanceOf(ForbiddenException);
        await expect(staff.addNote(ctxA, randomUUID(), { body: 'unknown id' })).rejects.toBeInstanceOf(ForbiddenException);
      });
      expect(await noteCount()).toBe(before);
      expect(await auditRows('staff.note_added', { entityId: staffMember.profileId! })).toHaveLength(0);
    });

    it('over-length body via the SERVICE (no ValidationPipe in the path) → 400, nothing written', async () => {
      const before = await noteCount();
      await expect(staff.addNote(ctxA, staffMember.profileId!, { body: 'x'.repeat(NOTE_BODY_MAX_LENGTH + 1) })).rejects.toBeInstanceOf(BadRequestException);
      await expect(staff.addNote(ctxA, staffMember.profileId!, { body: '' })).rejects.toBeInstanceOf(BadRequestException);
      expect(await noteCount()).toBe(before);
      expect(await auditRows('staff.note_added', { entityId: staffMember.profileId! })).toHaveLength(0);
    });

    it('over-length body via HTTP → 400 from the DTO; exactly 2,000 characters is accepted (201)', async () => {
      const token = await factory.login(a);
      const post = (body: string) => request(app.getHttpServer()).post(`/rest/v1/staff/${staffMember.profileId}/notes`).set('Authorization', `Bearer ${token}`).send({ body });
      const before = await noteCount();
      expect((await post('y'.repeat(NOTE_BODY_MAX_LENGTH + 1))).status).toBe(400);
      expect(await noteCount()).toBe(before);
      expect((await post('z'.repeat(NOTE_BODY_MAX_LENGTH))).status).toBe(201);
      expect(await noteCount()).toBe(before + 1);
    });

    it('with STAFF_EDIT: the note is written and audited with id + length only — never the note text', async () => {
      const secret = `Private detail ${randomUUID()}`;
      const note = await staff.addNote(ctxA, staffMember.profileId!, { body: secret });
      expect(note.body).toBe(secret);
      expect((await staff.listNotes(ctxA, staffMember.profileId!)).map((n) => n.id)).toContain(note.id);

      const rows = (await auditRows('staff.note_added', { entityId: staffMember.profileId! })).filter((r) => r.metadata?.noteId === note.id);
      expect(rows).toHaveLength(1);
      const [row] = rows;
      expect(row!.actor_user_id).toBe(a.userId);
      expect(row!.target_user_id).toBe(staffMember.userId);
      expect(row!.entity_type).toBe('staff_profile');
      expect(row!.metadata).toEqual({ noteId: note.id, length: secret.length });
      expect(JSON.stringify(row)).not.toContain(secret);
    });
  });
});
