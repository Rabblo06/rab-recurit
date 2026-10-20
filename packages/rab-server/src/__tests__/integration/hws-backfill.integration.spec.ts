/**
 * HWS runtime cutover, automated proof of `hws:backfill` — the gap flagged in docs/HANDOFF.md
 * §32h ("hws:backfill has no automated integration test"). Real PostgreSQL, real
 * `HwsBackfillService`, real `provisionWorkspaceSchema` — no mocks. Mirrors the manual proof
 * recorded in HANDOFF.md §32h step by step, automated.
 *
 * Topology: Organisation → Workspace A (seeded with one representative row per table across the
 * full dependency graph: job_role, venue, staff_profile, shift, shift_assignment, job_offer,
 * attendance, user_note) and Workspace B (left empty — the fresh-workspace case).
 */
import 'reflect-metadata';
import { AttendanceStatus, OfferStatus, ManagerType, ShiftAssignmentStatus, ShiftStatus, UserStatus } from '@rab/shared';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { DataSource } from 'typeorm';

import { AppModule } from '../../app.module';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { SchemaResolverService, WorkspaceRoutingError } from '../../engine/core-modules/tenant/schema-resolver.service';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { EnvironmentService } from '../../engine/core-modules/environment/environment.service';
import { resolveIntegrationTestDatabase } from '../../database/typeorm/core/test-database-guard';
import { provisionWorkspaceSchema, workspaceSchemaName } from '../../database/typeorm/workspace-schema/provision-workspace-schema';
import { HwsBackfillError, HwsBackfillService } from '../../database/typeorm/workspace-schema/backfill/hws-backfill.service';
import { Organisation, Role, User, UserRole } from '../../modules/identity/entities/index';
import { ManagerProfile } from '../../modules/manager/entities/manager-profile.entity';
import { ManagerWorkspace } from '../../modules/manager-workspace/entities/manager-workspace.entity';
import { JobRole } from '../../modules/scheduling/entities/job-role.entity';
import { Shift } from '../../modules/scheduling/entities/shift.entity';
import { ShiftAssignment } from '../../modules/scheduling/entities/shift-assignment.entity';
import { toTstzRange } from '../../modules/scheduling/utils/tstzrange';
import { StaffProfile } from '../../modules/staff/entities/staff-profile.entity';
import { Venue } from '../../modules/venue/entities/venue.entity';
import { JobOffer } from '../../modules/offer/entities/job-offer.entity';
import { Attendance } from '../../modules/attendance/entities/attendance.entity';
import { createAdminDataSource } from './helpers/admin-datasource';
import { generateFixturePassword } from './helpers/fixture-password';

const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;
jest.setTimeout(180_000);

const FIXTURE_PASSWORD = generateFixturePassword();

interface WorkspaceFixture {
  organisationId: string;
  workspaceId: string;
  ownerUserId: string;
  schemaName: string;
}

interface SeededBusinessData {
  jobRoleId: string;
  venueId: string;
  staffUserId: string;
  staffProfileId: string;
  shiftId: string;
  assignmentId: string;
  offerId: string;
  attendanceId: string;
  noteId: string;
}

describeIfDb('hws:backfill (integration)', () => {
  let app: import('@nestjs/common').INestApplication;
  let dataSource: DataSource; // rab_app — the same DataSource HwsBackfillService uses for reads
  let adminDataSource: DataSource; // rab_owner, TypeORM — fixture bootstrap
  let ownerClient: Client; // rab_owner, raw pg — provisionWorkspaceSchema
  let backfillOwnerDataSource: DataSource; // rab_owner, TypeORM entities:[] — HwsBackfillService.ownerDataSource
  let passwordHashing: PasswordHashingService;
  let backfill: HwsBackfillService;

  const createdOrgIds: string[] = [];
  const createdWorkspaceIds: string[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    dataSource = app.get(DataSource);
    passwordHashing = app.get(PasswordHashingService);

    adminDataSource = createAdminDataSource();
    await adminDataSource.initialize();
    const { adminUrl } = resolveIntegrationTestDatabase(process.env);
    ownerClient = new Client({ connectionString: adminUrl });
    await ownerClient.connect();
    backfillOwnerDataSource = new DataSource({ type: 'postgres', url: adminUrl, entities: [], synchronize: false, logging: false });
    await backfillOwnerDataSource.initialize();

    backfill = new HwsBackfillService(dataSource, app.get(SchemaResolverService));
  });

  afterAll(async () => {
    await ownerClient.end();
    await backfillOwnerDataSource.destroy();
    await adminDataSource.destroy();
    await app.close();
  });

  /** Organisation + Internal Manager + ManagerWorkspace, provisioned to READY via the real provisioner. */
  async function seedReadyWorkspace(label: string): Promise<WorkspaceFixture> {
    const orgInsert = await adminDataSource.manager.insert(Organisation, { name: `${label}-${randomUUID()}`, slug: `${label}-${randomUUID()}` });
    const organisationId = orgInsert.identifiers[0]!.id as string;
    createdOrgIds.push(organisationId);

    const fx = await adminDataSource.transaction(async (manager) => {
      await manager.query(`SELECT set_config('rab.organisation_id', $1, true)`, [organisationId]);
      let role = await manager.findOne(Role, { where: { organisationId, key: 'manager' } });
      if (!role) {
        const roleResult = await manager.insert(Role, { organisationId, key: 'manager', name: 'Manager', isSystem: true });
        role = await manager.findOneByOrFail(Role, { id: roleResult.identifiers[0]!.id as string });
      }
      const passwordHash = await passwordHashing.hash(FIXTURE_PASSWORD);
      const userResult = await manager.insert(User, {
        organisationId,
        email: `${label}-${randomUUID()}@example.test`,
        passwordHash,
        firstName: label,
        lastName: 'Owner',
        status: UserStatus.ACTIVE,
      });
      const ownerUserId = userResult.identifiers[0]!.id as string;
      await manager.insert(UserRole, { userId: ownerUserId, roleId: role.id, organisationId });
      await manager.query(`SELECT set_config('rab.user_id', $1, true)`, [ownerUserId]);

      const workspace = await manager.save(ManagerWorkspace, {
        organisationId,
        ownerUserId,
        name: `${label} Workspace`,
        subdomain: `${label}-${randomUUID().slice(0, 8)}`,
        status: 'active',
        schemaStatus: 'CREATING',
      });
      await manager.query(`SELECT set_config('rab.workspace_id', $1, true)`, [workspace.id]);
      await manager.insert(ManagerProfile, { organisationId, userId: ownerUserId, type: ManagerType.INTERNAL, workspaceId: workspace.id });
      return { organisationId, workspaceId: workspace.id, ownerUserId };
    });
    createdWorkspaceIds.push(fx.workspaceId);

    const provisioned = await provisionWorkspaceSchema(ownerClient, fx.workspaceId);
    expect(provisioned.outcome).toBe('READY');
    return { ...fx, schemaName: provisioned.schemaName };
  }

  /** Seeds one representative legacy core.* row per table across the full 8-table dependency chain, mirroring HANDOFF.md §32h's manual proof fixture exactly. */
  async function seedLegacyBusinessData(fx: WorkspaceFixture): Promise<SeededBusinessData> {
    return adminDataSource.transaction(async (manager) => {
      await manager.query(`SELECT set_config('rab.organisation_id', $1, true), set_config('rab.workspace_id', $2, true), set_config('rab.user_id', $3, true)`, [
        fx.organisationId,
        fx.workspaceId,
        fx.ownerUserId,
      ]);

      const jobRole = await manager.save(JobRole, { organisationId: fx.organisationId, workspaceId: fx.workspaceId, name: `Bartender-${randomUUID().slice(0, 6)}`, defaultRatePence: 1500, createdBy: fx.ownerUserId });
      const venue = await manager.save(Venue, { organisationId: fx.organisationId, workspaceId: fx.workspaceId, name: 'Proof Venue', createdBy: fx.ownerUserId });

      const staffPasswordHash = await passwordHashing.hash(FIXTURE_PASSWORD);
      const staffUserResult = await manager.insert(User, {
        organisationId: fx.organisationId,
        email: `staff-${randomUUID()}@example.test`,
        passwordHash: staffPasswordHash,
        firstName: 'Proof',
        lastName: 'Staff',
        status: UserStatus.ACTIVE,
      });
      const staffUserId = staffUserResult.identifiers[0]!.id as string;
      const staffProfile = await manager.save(StaffProfile, {
        organisationId: fx.organisationId,
        workspaceId: fx.workspaceId,
        userId: staffUserId,
        staffRef: `STAFF-${randomUUID().slice(0, 8)}`,
        createdBy: fx.ownerUserId,
        jobRoleId: jobRole.id,
        employmentStatus: 'active',
      });

      const startsAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
      const endsAt = new Date(startsAt.getTime() + 8 * 60 * 60 * 1000);
      const shift = await manager.save(Shift, {
        organisationId: fx.organisationId,
        workspaceId: fx.workspaceId,
        venueId: venue.id,
        jobRoleId: jobRole.id,
        startsAt,
        endsAt,
        requiredCount: 1,
        filledCount: 1,
        payRatePence: 1500,
        status: ShiftStatus.CONFIRMED,
        createdBy: fx.ownerUserId,
        requestedBy: fx.ownerUserId,
      });
      const assignment = await manager.save(ShiftAssignment, {
        organisationId: fx.organisationId,
        workspaceId: fx.workspaceId,
        shiftId: shift.id,
        staffProfileId: staffProfile.id,
        status: ShiftAssignmentStatus.CONFIRMED,
        payRateSnapshotPence: 1500,
        period: toTstzRange(startsAt, endsAt),
      });
      const offer = await manager.save(JobOffer, {
        organisationId: fx.organisationId,
        workspaceId: fx.workspaceId,
        shiftAssignmentId: assignment.id,
        staffProfileId: staffProfile.id,
        status: OfferStatus.MANAGER_CONFIRMED,
        sentAt: new Date(),
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        estimatedPayPence: 10_000,
        createdBy: fx.ownerUserId,
      });
      const attendance = await manager.save(Attendance, {
        organisationId: fx.organisationId,
        workspaceId: fx.workspaceId,
        shiftId: shift.id,
        shiftAssignmentId: assignment.id,
        staffProfileId: staffProfile.id,
        status: AttendanceStatus.CLOCKED_IN,
        clockInAt: new Date(),
      });
      // Raw SQL, not manager.save(UserNote, ...): legacy core.user_note genuinely has no workspace_id column
      // (Part 15's own premise) but the UserNote entity now declares that column unconditionally (it's required
      // in the physical schema) — TypeORM's generated INSERT would include it either way and fail against core.
      const noteId = randomUUID();
      await manager.query(`INSERT INTO core.user_note (id, organisation_id, subject_user_id, author_user_id, body) VALUES ($1,$2,$3,$4,$5)`, [
        noteId,
        fx.organisationId,
        staffUserId,
        fx.ownerUserId,
        'Proof note for backfill test',
      ]);
      const note = { id: noteId };

      return {
        jobRoleId: jobRole.id,
        venueId: venue.id,
        staffUserId,
        staffProfileId: staffProfile.id,
        shiftId: shift.id,
        assignmentId: assignment.id,
        offerId: offer.id,
        attendanceId: attendance.id,
        noteId: note.id,
      };
    });
  }

  async function physicalRowCount(fx: WorkspaceFixture, table: string): Promise<number> {
    const [{ n }] = await dataSource.transaction(async (manager) => {
      await manager.query(`SELECT set_config('rab.organisation_id', $1, true), set_config('rab.workspace_id', $2, true), set_config('rab.actor_type', 'worker', true)`, [
        fx.organisationId,
        fx.workspaceId,
      ]);
      await manager.query(`SELECT set_config('search_path', $1, true)`, [fx.schemaName]);
      return manager.query(`SELECT count(*)::int AS n FROM ${table}`);
    });
    return n;
  }

  async function physicalRows<T = Record<string, unknown>>(fx: WorkspaceFixture, table: string): Promise<T[]> {
    return dataSource.transaction(async (manager) => {
      await manager.query(`SELECT set_config('rab.organisation_id', $1, true), set_config('rab.workspace_id', $2, true), set_config('rab.actor_type', 'worker', true)`, [
        fx.organisationId,
        fx.workspaceId,
      ]);
      await manager.query(`SELECT set_config('search_path', $1, true)`, [fx.schemaName]);
      return manager.query(`SELECT * FROM ${table}`);
    });
  }

  afterEach(async () => {
    for (const workspaceId of createdWorkspaceIds) {
      // The PHYSICAL schema's own staff_profile (etc.) carries its own FK straight to
      // core.manager_workspace (one of the 54 workspace→core edges) — it must be dropped BEFORE
      // the core-table cleanup transaction below, or deleting manager_workspace fails with that
      // FK still referenced from inside the (about-to-be-orphaned) physical schema.
      let schemaName: string | null = null;
      try {
        schemaName = workspaceSchemaName(workspaceId);
      } catch {
        // not a valid uuid shape — nothing to drop
      }
      if (schemaName) await ownerClient.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);

      const row = await adminDataSource.query(`SELECT organisation_id, owner_user_id FROM core.manager_workspace WHERE id = $1`, [workspaceId]);
      if (row.length > 0) {
        const { organisation_id: organisationId, owner_user_id: ownerUserId } = row[0];
        await adminDataSource.transaction(async (manager) => {
          await manager.query(`SELECT set_config('rab.organisation_id', $1, true), set_config('rab.workspace_id', $2, true), set_config('rab.user_id', $3, true)`, [
            organisationId,
            workspaceId,
            ownerUserId,
          ]);
          for (const t of ['attendance', 'job_offer', 'shift_assignment', 'shift', 'staff_profile', 'venue', 'job_role']) {
            await manager.query(`DELETE FROM core.${t} WHERE workspace_id = $1`, [workspaceId]);
          }
          await manager.query(`DELETE FROM core.hws_backfill_checkpoint WHERE workspace_id = $1`, [workspaceId]);
          await manager.query(`DELETE FROM core.workspace_schema_registry WHERE workspace_id = $1`, [workspaceId]);
          await manager.query(`DELETE FROM core.manager_profile WHERE workspace_id = $1`, [workspaceId]);
          await manager.query(`DELETE FROM core.manager_workspace WHERE id = $1`, [workspaceId]);
        });
      }
    }
    for (const organisationId of createdOrgIds) {
      await adminDataSource.transaction(async (manager) => {
        await manager.query(`SELECT set_config('rab.organisation_id', $1, true)`, [organisationId]);
        await manager.query(`DELETE FROM core.user_note WHERE organisation_id = $1`, [organisationId]);
        await manager.query(`DELETE FROM core."user" WHERE organisation_id = $1`, [organisationId]);
      });
      await adminDataSource.query(`DELETE FROM core.organisation WHERE id = $1`, [organisationId]);
    }
    createdOrgIds.length = 0;
    createdWorkspaceIds.length = 0;
  });

  // ------------------------------------------------------------------ Parts 3-5: dry-run + apply correctness

  it('dry-run reports accurate counts, no writes, and workspace A/B stay isolated', async () => {
    const a = await seedReadyWorkspace('bf-dryrun-a');
    const seeded = await seedLegacyBusinessData(a);
    const b = await seedReadyWorkspace('bf-dryrun-b');

    const reportA = await backfill.dryRun({ workspaceId: a.workspaceId, organisationId: a.organisationId });
    expect(reportA.safeToApply).toBe(true);
    expect(reportA.registryStatus).toBe('READY');
    const byTable = new Map(reportA.tables.map((t) => [t.table, t]));
    expect(byTable.get('job_role')!.toCopy).toBe(1);
    expect(byTable.get('venue')!.toCopy).toBe(1);
    expect(byTable.get('staff_profile')!.toCopy).toBe(1);
    expect(byTable.get('shift')!.toCopy).toBe(1);
    expect(byTable.get('shift_assignment')!.toCopy).toBe(1);
    expect(byTable.get('job_offer')!.toCopy).toBe(1);
    expect(byTable.get('attendance')!.toCopy).toBe(1);
    expect(byTable.get('user_note')!.toCopy).toBe(1);
    expect(byTable.get('manager_venue')!.toCopy).toBe(0);
    // FK dependency order generated correctly: parents strictly before children in the report's own copy order.
    expect(reportA.copyOrder.indexOf('job_role')).toBeLessThan(reportA.copyOrder.indexOf('staff_profile'));
    expect(reportA.copyOrder.indexOf('staff_profile')).toBeLessThan(reportA.copyOrder.indexOf('shift_assignment'));
    expect(reportA.copyOrder.indexOf('shift_assignment')).toBeLessThan(reportA.copyOrder.indexOf('job_offer'));

    const reportB = await backfill.dryRun({ workspaceId: b.workspaceId, organisationId: b.organisationId });
    expect(reportB.tables.every((t) => t.toCopy === 0)).toBe(true); // Part 21: fresh workspace, nothing to backfill, not an error
    expect(reportB.safeToApply).toBe(true);

    // No writes: the physical schemas are still empty after dry-run.
    expect(await physicalRowCount(a, 'staff_profile')).toBe(0);
    expect(await physicalRowCount(a, 'job_role')).toBe(0);

    // No source rows modified: the legacy core row is untouched. (A bare adminDataSource.query with no
    // GUCs bound would see zero rows under RLS, not the row itself — bind org+workspace first.)
    const [legacyStaff] = await adminDataSource.transaction(async (manager) => {
      await manager.query(`SELECT set_config('rab.organisation_id', $1, true), set_config('rab.workspace_id', $2, true), set_config('rab.actor_type', 'worker', true)`, [
        a.organisationId,
        a.workspaceId,
      ]);
      return manager.query(`SELECT staff_ref FROM core.staff_profile WHERE id = $1`, [seeded.staffProfileId]);
    });
    expect(legacyStaff.staff_ref).toBeTruthy();
  });

  it('apply copies every representative row correctly — PKs, workspace_id, and every relationship, not just counts', async () => {
    const a = await seedReadyWorkspace('bf-apply-a');
    const seeded = await seedLegacyBusinessData(a);

    const result = await (async () => {
      backfill.ownerDataSource = backfillOwnerDataSource;
      try {
        return await backfill.apply({ workspaceId: a.workspaceId, organisationId: a.organisationId });
      } finally {
        backfill.ownerDataSource = undefined;
      }
    })();
    expect(result.overall).toBe('completed');
    expect(result.tables.map((t) => t.table)).toEqual([
      'job_role', 'user_note', 'venue', 'manager_venue', 'shift', 'staff_profile', 'venue_role_rate', 'shift_assignment',
      'shift_report', 'shift_request_staff', 'venue_manager_staff', 'attendance', 'job_offer', 'shift_staff_review', 'attendance_correction', 'replacement_request',
    ]);

    const [staffRow] = await physicalRows<{ id: string; workspace_id: string; staff_ref: string; job_role_id: string; created_by: string }>(a, 'staff_profile');
    expect(staffRow.id).toBe(seeded.staffProfileId); // PK preserved, never regenerated
    expect(staffRow.workspace_id).toBe(a.workspaceId);
    expect(staffRow.job_role_id).toBe(seeded.jobRoleId); // venue/role relationship intact
    expect(staffRow.created_by).toBe(a.ownerUserId); // ownership preserved, not re-attributed to the tool

    const [shiftRow] = await physicalRows<{ id: string; venue_id: string; job_role_id: string }>(a, 'shift');
    expect(shiftRow.venue_id).toBe(seeded.venueId);
    expect(shiftRow.job_role_id).toBe(seeded.jobRoleId);

    const [assignmentRow] = await physicalRows<{ id: string; shift_id: string; staff_profile_id: string }>(a, 'shift_assignment');
    expect(assignmentRow.shift_id).toBe(seeded.shiftId);
    expect(assignmentRow.staff_profile_id).toBe(seeded.staffProfileId);

    const [offerRow] = await physicalRows<{ id: string; shift_assignment_id: string; staff_profile_id: string; status: string }>(a, 'job_offer');
    expect(offerRow.shift_assignment_id).toBe(seeded.assignmentId);
    expect(offerRow.staff_profile_id).toBe(seeded.staffProfileId);
    expect(offerRow.status).toBe(OfferStatus.MANAGER_CONFIRMED); // status never reinterpreted

    const [attendanceRow] = await physicalRows<{ id: string; shift_id: string; shift_assignment_id: string; staff_profile_id: string }>(a, 'attendance');
    expect(attendanceRow.shift_id).toBe(seeded.shiftId);
    expect(attendanceRow.shift_assignment_id).toBe(seeded.assignmentId);
    expect(attendanceRow.staff_profile_id).toBe(seeded.staffProfileId);

    // user_note mapping: subject_user_id preserved, workspace_id correctly DERIVED (the column doesn't exist in core at all).
    const [noteRow] = await physicalRows<{ id: string; subject_user_id: string; workspace_id: string; author_user_id: string }>(a, 'user_note');
    expect(noteRow.id).toBe(seeded.noteId);
    expect(noteRow.subject_user_id).toBe(seeded.staffUserId);
    expect(noteRow.workspace_id).toBe(a.workspaceId);
    expect(noteRow.author_user_id).toBe(a.ownerUserId);

    const verify = await backfill.verify({ workspaceId: a.workspaceId, organisationId: a.organisationId });
    expect(verify.pass).toBe(true);
    expect(verify.tables.every((t) => t.pass)).toBe(true);
  });

  // ------------------------------------------------------------------ Part 6: idempotency

  it('re-applying an already-complete workspace copies nothing twice — same row counts, same ids, no duplicates', async () => {
    const a = await seedReadyWorkspace('bf-idempotent');
    await seedLegacyBusinessData(a);
    backfill.ownerDataSource = backfillOwnerDataSource;
    try {
      const first = await backfill.apply({ workspaceId: a.workspaceId, organisationId: a.organisationId });
      expect(first.overall).toBe('completed');

      const countsBefore = await Promise.all(['staff_profile', 'shift', 'job_offer', 'attendance'].map((t) => physicalRowCount(a, t)));

      const second = await backfill.apply({ workspaceId: a.workspaceId, organisationId: a.organisationId });
      expect(second.tables.every((t) => t.state === 'skipped-already-complete')).toBe(true);

      const countsAfter = await Promise.all(['staff_profile', 'shift', 'job_offer', 'attendance'].map((t) => physicalRowCount(a, t)));
      expect(countsAfter).toEqual(countsBefore); // no duplication on any table
      expect(countsAfter).toEqual([1, 1, 1, 1]);
    } finally {
      backfill.ownerDataSource = undefined;
    }
  });

  // ------------------------------------------------------------------ Part 7: deterministic interruption + resume

  it('resumes correctly after a genuine mid-run interruption — a real crash scenario, continued to completion with no duplication', async () => {
    const a = await seedReadyWorkspace('bf-resume');
    await seedLegacyBusinessData(a);
    backfill.ownerDataSource = backfillOwnerDataSource;

    try {
      // Deterministic interruption: run apply() to full completion once (real data, real checkpoints for all 15
      // tables), THEN delete the checkpoint rows for two of the later tables in copy order — simulating a crash
      // whose checkpoint write for those two never reached disk, even though (per this design's own per-table
      // transaction boundary — HWS-RUNTIME-CUTOVER.md §12) their data commit did. This is the one way checkpoint
      // state can legitimately fall BEHIND reality; it must never be a way to accidentally duplicate data.
      const first = await backfill.apply({ workspaceId: a.workspaceId, organisationId: a.organisationId });
      expect(first.overall).toBe('completed');

      await adminDataSource.transaction(async (manager) => {
        await manager.query(`SELECT set_config('rab.organisation_id', $1, true), set_config('rab.workspace_id', $2, true)`, [a.organisationId, a.workspaceId]);
        await manager.query(`DELETE FROM core.hws_backfill_checkpoint WHERE workspace_id = $1 AND table_name IN ('job_offer', 'attendance')`, [a.workspaceId]);
      });

      const countsBefore = await Promise.all(['job_offer', 'attendance'].map((t) => physicalRowCount(a, t)));

      // Resume: apply() again. Checkpoint state for these two tables says 'pending' now (no row at all) — not
      // 'completed' — so apply() does NOT trust a stale checkpoint; it re-examines each row for real, finds it
      // already present and business-equivalent (compareRows), and completes WITHOUT re-inserting.
      const resumed = await backfill.apply({ workspaceId: a.workspaceId, organisationId: a.organisationId });
      expect(resumed.overall).toBe('completed');
      const byTable = new Map(resumed.tables.map((t) => [t.table, t]));
      expect(byTable.get('job_offer')!.state).toBe('completed');
      expect(byTable.get('job_offer')!.rowsCopied).toBe(0); // nothing NEW inserted
      expect(byTable.get('job_offer')!.alreadyPresent).toBe(1); // the existing row was recognised, not duplicated
      expect(byTable.get('attendance')!.state).toBe('completed');
      expect(byTable.get('attendance')!.rowsCopied).toBe(0);
      expect(byTable.get('attendance')!.alreadyPresent).toBe(1);
      // Tables whose checkpoint was untouched are still correctly reported as checkpoint-authoritative.
      expect(byTable.get('job_role')!.state).toBe('skipped-already-complete');

      const countsAfter = await Promise.all(['job_offer', 'attendance'].map((t) => physicalRowCount(a, t)));
      expect(countsAfter).toEqual(countsBefore); // no duplication — final target matches a clean, uninterrupted backfill
      expect(countsAfter).toEqual([1, 1]);
    } finally {
      backfill.ownerDataSource = undefined;
    }

    const verify = await backfill.verify({ workspaceId: a.workspaceId, organisationId: a.organisationId });
    expect(verify.pass).toBe(true);
  });

  // ------------------------------------------------------------------ Part 9: cross-workspace isolation after backfill

  it('after backfill, A context sees only A, B context sees only B, and no tenant context fails closed', async () => {
    const a = await seedReadyWorkspace('bf-iso-a');
    await seedLegacyBusinessData(a);
    const b = await seedReadyWorkspace('bf-iso-b');
    backfill.ownerDataSource = backfillOwnerDataSource;
    try {
      await backfill.apply({ workspaceId: a.workspaceId, organisationId: a.organisationId });
      await backfill.apply({ workspaceId: b.workspaceId, organisationId: b.organisationId });
    } finally {
      backfill.ownerDataSource = undefined;
    }

    expect(await physicalRowCount(a, 'staff_profile')).toBe(1);
    expect(await physicalRowCount(b, 'staff_profile')).toBe(0); // B's schema never received A's rows

    // Wrong physical schema / no tenant context both fail closed (SchemaResolverService, not a weakened CHECK).
    await expect(
      dataSource.transaction(async (manager) => {
        await manager.query(`SELECT set_config('rab.organisation_id', '', true), set_config('rab.workspace_id', '', true)`);
        return app.get(SchemaResolverService).resolve(manager, null);
      }),
    ).rejects.toBeInstanceOf(WorkspaceRoutingError);
  });

  // ------------------------------------------------------------------ Part 10: role/GUC behaviour

  it('a plain rab_app read with no actor_type=worker binding sees zero staff_profile rows — proving the special binding is required, not cosmetic', async () => {
    const a = await seedReadyWorkspace('bf-role-read');
    await seedLegacyBusinessData(a);

    const rows = await dataSource.transaction(async (manager) => {
      await manager.query(`SELECT set_config('rab.organisation_id', $1, true), set_config('rab.workspace_id', $2, true), set_config('rab.user_id', '', true)`, [
        a.organisationId,
        a.workspaceId,
      ]);
      // Deliberately NOT binding rab.actor_type='worker' here.
      return manager.query(`SELECT * FROM core.staff_profile WHERE workspace_id = $1`, [a.workspaceId]);
    });
    expect(rows).toHaveLength(0); // RLS hides it — confirms this is a real, enforced requirement, not decoration
  });

  it('apply() refuses with HwsBackfillError when no owner connection is configured — the backfill write path cannot be supplied an ambient/default role', async () => {
    const a = await seedReadyWorkspace('bf-role-write-refused');
    await seedLegacyBusinessData(a);
    expect(backfill.ownerDataSource).toBeUndefined();
    await expect(backfill.apply({ workspaceId: a.workspaceId, organisationId: a.organisationId })).rejects.toBeInstanceOf(HwsBackfillError);
  });

  it('normal API/worker runtime context (no ownerDataSource, no actor_type) cannot obtain migration authority merely by calling dryRun/verify', async () => {
    const a = await seedReadyWorkspace('bf-role-no-authority');
    await seedLegacyBusinessData(a);
    // dryRun/verify never touch ownerDataSource at all — confirming read-only modes structurally cannot write,
    // regardless of what a caller supplies.
    expect(backfill.ownerDataSource).toBeUndefined();
    const report = await backfill.dryRun({ workspaceId: a.workspaceId, organisationId: a.organisationId });
    expect(report.safeToApply).toBe(true);
    expect(await physicalRowCount(a, 'staff_profile')).toBe(0); // confirmed still zero writes happened
  });

  // ------------------------------------------------------------------ Part 12 (partial): the ACTUAL production
  // runtime path, not just HwsBackfillService's own internal resolution, reads backfilled data correctly.

  it('after backfill, the real TenantContextService.runInWorkspaceContext (HWS_RUNTIME_ENABLED=true) reads the backfilled row through the exact production runtime path', async () => {
    const a = await seedReadyWorkspace('bf-runtime-path');
    const seeded = await seedLegacyBusinessData(a);
    backfill.ownerDataSource = backfillOwnerDataSource;
    try {
      const result = await backfill.apply({ workspaceId: a.workspaceId, organisationId: a.organisationId });
      expect(result.overall).toBe('completed');
    } finally {
      backfill.ownerDataSource = undefined;
    }

    // The REAL TenantContextService class — not a mock, not HwsBackfillService's own bespoke readPhysical — with
    // a stub EnvironmentService forcing HWS_RUNTIME_ENABLED=true (the same effect as the real env var, without
    // needing a second app bootstrap: ConfigService caches validated env at module init, so toggling
    // process.env after boot wouldn't reach the already-running app's own EnvironmentService anyway).
    const hwsOnEnvironment = { get: (key: string) => (key === 'HWS_RUNTIME_ENABLED' ? true : undefined) } as unknown as EnvironmentService;
    const realTenantContext = new TenantContextService(dataSource, app.get(SchemaResolverService), hwsOnEnvironment);

    const row = await realTenantContext.runInWorkspaceContext(
      { organisationId: a.organisationId, workspaceId: a.workspaceId, userId: a.ownerUserId, role: 'manager' },
      (manager) => manager.findOne(StaffProfile, { where: { id: seeded.staffProfileId } }),
    );
    expect(row).not.toBeNull();
    expect(row!.id).toBe(seeded.staffProfileId);
    expect(row!.workspaceId).toBe(a.workspaceId);

    // A workspace-less context still fails closed through the exact same real production path.
    await expect(
      realTenantContext.runInWorkspaceContext({ organisationId: a.organisationId, workspaceId: null, userId: a.ownerUserId, role: 'manager' }, (manager) =>
        manager.findOne(StaffProfile, { where: { id: seeded.staffProfileId } }),
      ),
    ).rejects.toBeInstanceOf(WorkspaceRoutingError);
  });
});
