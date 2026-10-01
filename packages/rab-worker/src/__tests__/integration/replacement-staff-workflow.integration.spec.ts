import 'reflect-metadata';
import {
  EmploymentStatus,
  ManagerType,
  NotificationType,
  OfferStatus,
  ReplacementCandidateSnapshot,
  ReplacementRequestStatus,
  ShiftAssignmentStatus,
  ShiftStatus,
  UserStatus,
} from '@rab/shared';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';

import { AppModule } from '@rab/server/app.module';
import { AuditService } from '@rab/server/engine/core-modules/audit/audit.service';
import { PasswordHashingService } from '@rab/server/engine/core-modules/auth/services/password-hashing.service';
import { AuthContext } from '@rab/server/engine/core-modules/tenant/auth-context.interface';
import { TenantContextService } from '@rab/server/engine/core-modules/tenant/tenant-context.service';
import { Organisation, Role, User, UserRole } from '@rab/server/modules/identity/entities/index';
import { ManagerProfile } from '@rab/server/modules/manager/entities/manager-profile.entity';
import { ManagerWorkspace } from '@rab/server/modules/manager-workspace/entities/manager-workspace.entity';
import { NotificationService } from '@rab/server/modules/notification/services/notification.service';
import { JobOffer } from '@rab/server/modules/offer/entities/job-offer.entity';
import { ReplacementRequest } from '@rab/server/modules/offer/entities/replacement-request.entity';
import { ReplacementRequestService } from '@rab/server/modules/offer/services/replacement-request.service';
import { JobRole } from '@rab/server/modules/scheduling/entities/job-role.entity';
import { Shift } from '@rab/server/modules/scheduling/entities/shift.entity';
import { ShiftAssignment } from '@rab/server/modules/scheduling/entities/shift-assignment.entity';
import { toTstzRange } from '@rab/server/modules/scheduling/utils/tstzrange';
import { StaffProfile } from '@rab/server/modules/staff/entities/staff-profile.entity';
import { Venue } from '@rab/server/modules/venue/entities/venue.entity';
import { isLockUnavailable } from '../helpers/legacy-discovery-lock';
import { runReplacementStaffCycle } from '../../queues/rab-offers/replacement-staff.job';
import { createAdminDataSource } from './helpers/admin-datasource';

/**
 * Phase 4 — replacement-staff workflow correctness. Real Postgres, RLS on,
 * no mocks. Covers: request-creation idempotency, eligibility (org/
 * workspace/active-status/overlap/availability), deterministic ranking,
 * canonical manager-recipient resolution, the atomic-claim approval flow
 * (double-approval, approve-vs-reject, approve-vs-cancellation, stale-
 * candidate revalidation), canonical `OfferService` integration, tenant/RLS
 * isolation, audit-exactly-once under concurrency, and the `shift_
 * assignment.period` SQL regression.
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;
jest.setTimeout(60_000);

describeIfDb('replacement-staff workflow (integration)', () => {
  let app: import('@nestjs/common').INestApplication;
  let dataSource: DataSource;
  let adminDataSource: DataSource;
  let passwordHashing: PasswordHashingService;
  let tenantContext: TenantContextService;
  let auditService: AuditService;
  let notificationService: NotificationService;
  let replacementRequestService: ReplacementRequestService;

  interface OrgFixture {
    organisationId: string;
    workspaceId: string;
    managerUserId: string;
    venueId: string;
    jobRoleId: string;
  }

  async function withContext<T>(ctx: { organisationId: string; workspaceId: string | null; userId: string }, fn: (manager: DataSource['manager']) => Promise<T>): Promise<T> {
    return dataSource.transaction(async (manager) => {
      await manager.query(`SELECT set_config('rab.organisation_id', $1, true)`, [ctx.organisationId]);
      await manager.query(`SELECT set_config('rab.workspace_id', $1, true)`, [ctx.workspaceId ?? '']);
      await manager.query(`SELECT set_config('rab.user_id', $1, true)`, [ctx.userId]);
      await manager.query(`SELECT set_config('rab.role', '', true)`);
      return fn(manager);
    });
  }

  function authCtx(fx: OrgFixture, userId = fx.managerUserId): AuthContext {
    return { organisationId: fx.organisationId, workspaceId: fx.workspaceId, userId, role: 'manager' };
  }

  async function createManager(organisationId: string, workspaceId: string, label: string): Promise<string> {
    return withContext({ organisationId, workspaceId, userId: randomUUID() }, async (manager) => {
      let role = await manager.findOne(Role, { where: { organisationId, key: 'manager' } });
      if (!role) {
        const roleResult = await manager.insert(Role, { organisationId, key: 'manager', name: 'Manager', isSystem: true });
        role = await manager.findOneByOrFail(Role, { id: roleResult.identifiers[0]!.id as string });
      }
      const hash = await passwordHashing.hash('correct horse battery staple 1!');
      const userResult = await manager.insert(User, {
        organisationId,
        email: `${label}-${randomUUID()}@example.test`,
        passwordHash: hash,
        firstName: label,
        lastName: 'Manager',
        status: UserStatus.ACTIVE,
      });
      const userId = userResult.identifiers[0]!.id as string;
      await manager.insert(UserRole, { userId, roleId: role.id, organisationId });
      await manager.insert(ManagerProfile, { organisationId, userId, type: ManagerType.INTERNAL, workspaceId });
      return userId;
    });
  }

  async function seedOrgFixture(label: string): Promise<OrgFixture> {
    const orgInsert = await adminDataSource.manager.insert(Organisation, { name: `${label}-${randomUUID()}`, slug: `${label}-${randomUUID()}` });
    const organisationId = orgInsert.identifiers[0]!.id as string;

    let workspaceId!: string;
    let venueId!: string;
    let jobRoleId!: string;

    const bootstrapManagerId = await withContext({ organisationId, workspaceId: null, userId: randomUUID() }, async (manager) => {
      let role = await manager.findOne(Role, { where: { organisationId, key: 'manager' } });
      if (!role) {
        const roleResult = await manager.insert(Role, { organisationId, key: 'manager', name: 'Manager', isSystem: true });
        role = await manager.findOneByOrFail(Role, { id: roleResult.identifiers[0]!.id as string });
      }
      const managerHash = await passwordHashing.hash('correct horse battery staple 1!');
      const managerResult = await manager.insert(User, {
        organisationId,
        email: `${label}-owner-${randomUUID()}@example.test`,
        passwordHash: managerHash,
        firstName: label,
        lastName: 'Manager',
        status: UserStatus.ACTIVE,
      });
      const managerUserId = managerResult.identifiers[0]!.id as string;
      await manager.insert(UserRole, { userId: managerUserId, roleId: role.id, organisationId });

      await manager.query(`SELECT set_config('rab.user_id', $1, true)`, [managerUserId]);
      const workspace = await manager.save(ManagerWorkspace, {
        organisationId,
        ownerUserId: managerUserId,
        name: `${label} Workspace ${managerUserId}`,
        subdomain: `${label}-${managerUserId.slice(0, 8)}`,
        status: 'active',
      });
      workspaceId = workspace.id;
      await manager.insert(ManagerProfile, { organisationId, userId: managerUserId, type: ManagerType.INTERNAL, workspaceId });
      await manager.query(`SELECT set_config('rab.workspace_id', $1, true)`, [workspaceId]);

      const venue = await manager.save(Venue, { organisationId, name: `${label} Venue`, createdBy: managerUserId, workspaceId });
      venueId = venue.id;
      const jobRole = await manager.save(JobRole, { organisationId, name: `Bartender ${randomUUID().slice(0, 6)}`, defaultRatePence: 1500, createdBy: managerUserId, workspaceId });
      jobRoleId = jobRole.id;
      return managerUserId;
    });

    return { organisationId, workspaceId, managerUserId: bootstrapManagerId, venueId, jobRoleId };
  }

  interface StaffFixture {
    staffProfileId: string;
    userId: string;
  }

  async function seedStaff(
    fx: OrgFixture,
    label: string,
    overrides?: {
      employmentStatus?: string;
      userStatus?: string;
      jobRoleId?: string | null;
      availableDays?: string[] | null;
      otherSkills?: string | null;
    },
  ): Promise<StaffFixture> {
    return withContext({ organisationId: fx.organisationId, workspaceId: fx.workspaceId, userId: fx.managerUserId }, async (manager) => {
      const hash = await passwordHashing.hash('correct horse battery staple 1!');
      const userResult = await manager.insert(User, {
        organisationId: fx.organisationId,
        email: `${label}-${randomUUID()}@example.test`,
        passwordHash: hash,
        firstName: label,
        lastName: 'Staff',
        status: overrides?.userStatus ?? UserStatus.ACTIVE,
      });
      const userId = userResult.identifiers[0]!.id as string;
      let staffRole = await manager.findOne(Role, { where: { organisationId: fx.organisationId, key: 'staff' } });
      if (!staffRole) {
        const staffRoleResult = await manager.insert(Role, { organisationId: fx.organisationId, key: 'staff', name: 'Staff', isSystem: true });
        staffRole = await manager.findOneByOrFail(Role, { id: staffRoleResult.identifiers[0]!.id as string });
      }
      await manager.insert(UserRole, { userId, roleId: staffRole.id, organisationId: fx.organisationId });
      const staffProfile = await manager.save(StaffProfile, {
        organisationId: fx.organisationId,
        userId,
        staffRef: `STF-${label}-${randomUUID().slice(0, 8)}`,
        employmentStatus: overrides?.employmentStatus ?? EmploymentStatus.ACTIVE,
        jobRoleId: overrides && 'jobRoleId' in overrides ? (overrides.jobRoleId ?? undefined) : fx.jobRoleId,
        availableDays: overrides && 'availableDays' in overrides ? (overrides.availableDays ?? undefined) : undefined,
        otherSkills: overrides && 'otherSkills' in overrides ? (overrides.otherSkills ?? undefined) : undefined,
        createdBy: fx.managerUserId,
        workspaceId: fx.workspaceId,
      });
      return { staffProfileId: staffProfile.id, userId };
    });
  }

  interface DeclinedOfferFixture {
    shiftId: string;
    declinedAssignmentId: string;
    declinedOfferId: string;
  }

  /** The core trigger: an OPEN shift with one DECLINED/EXPIRED offer against a distinct "declining" staff member — exactly the shape `runReplacementStaffCycle`'s scan query looks for. */
  async function seedDeclinedOfferShift(
    fx: OrgFixture,
    decliningStaff: StaffFixture,
    opts?: { startsAt?: Date; endsAt?: Date; offerStatus?: string; requiredCount?: number; filledCount?: number; assignedBy?: string | null; shiftStatus?: string },
  ): Promise<DeclinedOfferFixture> {
    const startsAt = opts?.startsAt ?? new Date(Date.now() + 3 * 3600 * 1000);
    const endsAt = opts?.endsAt ?? new Date(startsAt.getTime() + 8 * 3600 * 1000);
    return withContext({ organisationId: fx.organisationId, workspaceId: fx.workspaceId, userId: fx.managerUserId }, async (manager) => {
      const shift = await manager.save(Shift, {
        organisationId: fx.organisationId,
        venueId: fx.venueId,
        jobRoleId: fx.jobRoleId,
        startsAt,
        endsAt,
        breakMinutes: 0,
        requiredCount: opts?.requiredCount ?? 1,
        filledCount: opts?.filledCount ?? 0,
        payRatePence: 1500,
        status: opts?.shiftStatus ?? ShiftStatus.OPEN,
        createdBy: fx.managerUserId,
        workspaceId: fx.workspaceId,
      });
      const assignment = await manager.save(ShiftAssignment, {
        organisationId: fx.organisationId,
        shiftId: shift.id,
        staffProfileId: decliningStaff.staffProfileId,
        status: ShiftAssignmentStatus.DECLINED,
        payRateSnapshotPence: 1500,
        assignedBy: opts && 'assignedBy' in opts ? (opts.assignedBy ?? undefined) : fx.managerUserId,
        period: toTstzRange(startsAt, endsAt),
        workspaceId: fx.workspaceId,
      });
      const offer = await manager.save(JobOffer, {
        organisationId: fx.organisationId,
        shiftAssignmentId: assignment.id,
        staffProfileId: decliningStaff.staffProfileId,
        status: opts?.offerStatus ?? OfferStatus.DECLINED,
        sentAt: new Date(Date.now() - 3600 * 1000),
        expiresAt: new Date(Date.now() + 3600 * 1000),
        respondedAt: new Date(),
        estimatedPayPence: 12000,
        workspaceId: fx.workspaceId,
      });
      return { shiftId: shift.id, declinedAssignmentId: assignment.id, declinedOfferId: offer.id };
    });
  }

  /** Directly seeds a `ReplacementRequest` row with a known shortlist — used by the approval-race tests, which need full control over the shortlist rather than depending on the worker's own ranking. */
  async function seedReplacementRequest(
    fx: OrgFixture,
    fixture: DeclinedOfferFixture,
    candidates: ReplacementCandidateSnapshot[],
    status: string = ReplacementRequestStatus.AWAITING_APPROVAL,
  ): Promise<string> {
    return withContext({ organisationId: fx.organisationId, workspaceId: fx.workspaceId, userId: fx.managerUserId }, async (manager) => {
      const request = await manager.save(ReplacementRequest, {
        organisationId: fx.organisationId,
        workspaceId: fx.workspaceId,
        shiftId: fixture.shiftId,
        declinedShiftAssignmentId: fixture.declinedAssignmentId,
        declinedOfferId: fixture.declinedOfferId,
        status: status as never,
        candidatesSnapshot: candidates,
      });
      return request.id;
    });
  }

  async function getRequest(fx: OrgFixture, id: string): Promise<ReplacementRequest | null> {
    return withContext({ organisationId: fx.organisationId, workspaceId: fx.workspaceId, userId: fx.managerUserId }, (m) => m.findOne(ReplacementRequest, { where: { id } }));
  }

  async function candidateSnapshot(staffProfileId: string, score = 10): Promise<ReplacementCandidateSnapshot> {
    return { staffProfileId, firstName: 'Cand', lastName: staffProfileId.slice(0, 6), score, reasons: [] };
  }

  async function countAudit(fx: OrgFixture, action: string, entityId: string): Promise<number> {
    const rows = await withContext({ organisationId: fx.organisationId, workspaceId: fx.workspaceId, userId: fx.managerUserId }, (m) =>
      m.query<Array<{ count: string }>>(`SELECT count(*) FROM core.audit_log WHERE action = $1 AND entity_id = $2`, [action, entityId]),
    );
    return Number(rows[0]!.count);
  }

  /** `Promise.allSettled`, never `Promise.all` — see late-clock-in-correctness.integration.spec.ts's own doc comment for why. */
  async function raceAndReport<T>(attempts: Array<() => Promise<T>>): Promise<Array<{ ok: boolean; value?: T; error?: unknown }>> {
    const settled = await Promise.allSettled(attempts.map((run) => run()));
    return settled.map((r) => (r.status === 'fulfilled' ? { ok: true, value: r.value } : { ok: false, error: r.reason }));
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    dataSource = app.get(DataSource);
    passwordHashing = app.get(PasswordHashingService);
    tenantContext = app.get(TenantContextService);
    auditService = app.get(AuditService);
    notificationService = app.get(NotificationService);
    replacementRequestService = app.get(ReplacementRequestService);
    adminDataSource = createAdminDataSource();
    await adminDataSource.initialize();
  });

  afterAll(async () => {
    await app.close();
    await adminDataSource.destroy();
  });

  // ===================================================================
  // A. Request creation idempotency (worker)
  // ===================================================================
  describe('A. request creation idempotency', () => {
    it('A1: two concurrent worker cycles for the same decline create exactly one replacement_request row', async () => {
      const fx = await seedOrgFixture('idemA1');
      const declining = await seedStaff(fx, 'declining');
      const fixture = await seedDeclinedOfferShift(fx, declining);
      const run = () => runReplacementStaffCycle(adminDataSource, tenantContext, notificationService, auditService);
      await raceAndReport([run, run]);

      const rows = await withContext({ organisationId: fx.organisationId, workspaceId: fx.workspaceId, userId: fx.managerUserId }, (m) =>
        m.find(ReplacementRequest, { where: { declinedShiftAssignmentId: fixture.declinedAssignmentId } }),
      );
      expect(rows).toHaveLength(1);
    });

    it('A2: a second cycle after a request already exists never creates a duplicate', async () => {
      const fx = await seedOrgFixture('idemA2');
      const declining = await seedStaff(fx, 'declining');
      const fixture = await seedDeclinedOfferShift(fx, declining);
      await runReplacementStaffCycle(adminDataSource, tenantContext, notificationService, auditService);
      await runReplacementStaffCycle(adminDataSource, tenantContext, notificationService, auditService);

      const rows = await withContext({ organisationId: fx.organisationId, workspaceId: fx.workspaceId, userId: fx.managerUserId }, (m) =>
        m.find(ReplacementRequest, { where: { declinedShiftAssignmentId: fixture.declinedAssignmentId } }),
      );
      expect(rows).toHaveLength(1);
    });

    it('A3: an expired (not just declined) offer also triggers request creation', async () => {
      const fx = await seedOrgFixture('idemA3');
      const declining = await seedStaff(fx, 'declining');
      const fixture = await seedDeclinedOfferShift(fx, declining, { offerStatus: OfferStatus.EXPIRED });
      await runReplacementStaffCycle(adminDataSource, tenantContext, notificationService, auditService);
      const row = await withContext({ organisationId: fx.organisationId, workspaceId: fx.workspaceId, userId: fx.managerUserId }, (m) =>
        m.findOne(ReplacementRequest, { where: { declinedShiftAssignmentId: fixture.declinedAssignmentId } }),
      );
      expect(row).not.toBeNull();
    });

    it('A4: a cancelled shift is never discovered by the scan (no replacement_request created)', async () => {
      const fx = await seedOrgFixture('idemA4');
      const declining = await seedStaff(fx, 'declining');
      const fixture = await seedDeclinedOfferShift(fx, declining, { shiftStatus: ShiftStatus.CANCELLED });
      await runReplacementStaffCycle(adminDataSource, tenantContext, notificationService, auditService);
      const row = await withContext({ organisationId: fx.organisationId, workspaceId: fx.workspaceId, userId: fx.managerUserId }, (m) =>
        m.findOne(ReplacementRequest, { where: { declinedShiftAssignmentId: fixture.declinedAssignmentId } }),
      );
      expect(row).toBeNull();
    });

    it('A5: a shift already fully staffed is never discovered by the scan', async () => {
      const fx = await seedOrgFixture('idemA5');
      const declining = await seedStaff(fx, 'declining');
      const fixture = await seedDeclinedOfferShift(fx, declining, { requiredCount: 1, filledCount: 1 });
      await runReplacementStaffCycle(adminDataSource, tenantContext, notificationService, auditService);
      const row = await withContext({ organisationId: fx.organisationId, workspaceId: fx.workspaceId, userId: fx.managerUserId }, (m) =>
        m.findOne(ReplacementRequest, { where: { declinedShiftAssignmentId: fixture.declinedAssignmentId } }),
      );
      expect(row).toBeNull();
    });
  });

  // ===================================================================
  // B. Eligibility
  // ===================================================================
  describe('B. eligibility', () => {
    it('B1: the declining staff member is never their own replacement candidate', async () => {
      const fx = await seedOrgFixture('eligB1');
      const declining = await seedStaff(fx, 'declining');
      await seedDeclinedOfferShift(fx, declining);
      await runReplacementStaffCycle(adminDataSource, tenantContext, notificationService, auditService);
      const row = await withContext({ organisationId: fx.organisationId, workspaceId: fx.workspaceId, userId: fx.managerUserId }, (m) =>
        m.findOneByOrFail(ReplacementRequest, { organisationId: fx.organisationId }),
      );
      expect(row.status).toBe(ReplacementRequestStatus.NO_CANDIDATES);
      expect(row.candidatesSnapshot.find((c) => c.staffProfileId === declining.staffProfileId)).toBeUndefined();
    });

    it('B2: a non-ACTIVE employment status is excluded', async () => {
      const fx = await seedOrgFixture('eligB2');
      const declining = await seedStaff(fx, 'declining');
      await seedStaff(fx, 'inactive', { employmentStatus: EmploymentStatus.PENDING_COMPLIANCE });
      const fixture = await seedDeclinedOfferShift(fx, declining);
      await runReplacementStaffCycle(adminDataSource, tenantContext, notificationService, auditService);
      const row = await withContext({ organisationId: fx.organisationId, workspaceId: fx.workspaceId, userId: fx.managerUserId }, (m) =>
        m.findOneByOrFail(ReplacementRequest, { declinedShiftAssignmentId: fixture.declinedAssignmentId }),
      );
      expect(row.status).toBe(ReplacementRequestStatus.NO_CANDIDATES);
    });

    it('B3: a non-ACTIVE user account is excluded', async () => {
      const fx = await seedOrgFixture('eligB3');
      const declining = await seedStaff(fx, 'declining');
      await seedStaff(fx, 'deactivated', { userStatus: UserStatus.DEACTIVATED });
      const fixture = await seedDeclinedOfferShift(fx, declining);
      await runReplacementStaffCycle(adminDataSource, tenantContext, notificationService, auditService);
      const row = await withContext({ organisationId: fx.organisationId, workspaceId: fx.workspaceId, userId: fx.managerUserId }, (m) =>
        m.findOneByOrFail(ReplacementRequest, { declinedShiftAssignmentId: fixture.declinedAssignmentId }),
      );
      expect(row.status).toBe(ReplacementRequestStatus.NO_CANDIDATES);
    });

    it('B4 (SQL regression): a candidate with a CONFIRMED overlapping shift (via shift_assignment.period) is excluded', async () => {
      const fx = await seedOrgFixture('eligB4');
      const declining = await seedStaff(fx, 'declining');
      const candidate = await seedStaff(fx, 'busy');
      const startsAt = new Date(Date.now() + 3 * 3600 * 1000);
      const endsAt = new Date(startsAt.getTime() + 8 * 3600 * 1000);
      // The candidate already has a CONFIRMED assignment on a DIFFERENT shift
      // whose period overlaps the replacement shift's window — this can only
      // be detected by reading shift_assignment.period directly (shift has no
      // period column at all; querying a non-existent `s.period` would throw,
      // not silently miss the overlap — see this codebase's own Phase 1 fix).
      await withContext({ organisationId: fx.organisationId, workspaceId: fx.workspaceId, userId: fx.managerUserId }, async (manager) => {
        const otherShift = await manager.save(Shift, {
          organisationId: fx.organisationId,
          venueId: fx.venueId,
          jobRoleId: fx.jobRoleId,
          startsAt,
          endsAt,
          breakMinutes: 0,
          requiredCount: 1,
          payRatePence: 1500,
          status: ShiftStatus.CONFIRMED,
          createdBy: fx.managerUserId,
          workspaceId: fx.workspaceId,
        });
        await manager.save(ShiftAssignment, {
          organisationId: fx.organisationId,
          shiftId: otherShift.id,
          staffProfileId: candidate.staffProfileId,
          status: ShiftAssignmentStatus.CONFIRMED,
          payRateSnapshotPence: 1500,
          assignedBy: fx.managerUserId,
          confirmedAt: new Date(),
          period: toTstzRange(startsAt, endsAt),
          workspaceId: fx.workspaceId,
        });
      });
      const fixture = await seedDeclinedOfferShift(fx, declining, { startsAt, endsAt });
      await runReplacementStaffCycle(adminDataSource, tenantContext, notificationService, auditService);
      const row = await withContext({ organisationId: fx.organisationId, workspaceId: fx.workspaceId, userId: fx.managerUserId }, (m) =>
        m.findOneByOrFail(ReplacementRequest, { declinedShiftAssignmentId: fixture.declinedAssignmentId }),
      );
      expect(row.status).toBe(ReplacementRequestStatus.NO_CANDIDATES);
      expect(row.candidatesSnapshot).toHaveLength(0);
    });

    it('B5: a candidate already offered this exact shift is excluded', async () => {
      const fx = await seedOrgFixture('eligB5');
      const declining = await seedStaff(fx, 'declining');
      const candidate = await seedStaff(fx, 'alreadyOffered');
      const fixture = await seedDeclinedOfferShift(fx, declining);
      await withContext({ organisationId: fx.organisationId, workspaceId: fx.workspaceId, userId: fx.managerUserId }, (m) =>
        m.save(ShiftAssignment, {
          organisationId: fx.organisationId,
          shiftId: fixture.shiftId,
          staffProfileId: candidate.staffProfileId,
          status: ShiftAssignmentStatus.OFFERED,
          payRateSnapshotPence: 1500,
          assignedBy: fx.managerUserId,
          period: toTstzRange(new Date(), new Date(Date.now() + 3600 * 1000)),
          workspaceId: fx.workspaceId,
        }),
      );
      await runReplacementStaffCycle(adminDataSource, tenantContext, notificationService, auditService);
      const row = await withContext({ organisationId: fx.organisationId, workspaceId: fx.workspaceId, userId: fx.managerUserId }, (m) =>
        m.findOneByOrFail(ReplacementRequest, { declinedShiftAssignmentId: fixture.declinedAssignmentId }),
      );
      expect(row.candidatesSnapshot.find((c) => c.staffProfileId === candidate.staffProfileId)).toBeUndefined();
    });

    it('B6 (timezone fix): a shift starting just after midnight UTC during BST is classified by its LONDON local weekday, not the UTC calendar day', async () => {
      const fx = await seedOrgFixture('eligB6');
      const declining = await seedStaff(fx, 'declining');
      // 2026-07-15T00:30:00Z is 15 July 2026 00:30 UTC — but in BST (UTC+1)
      // that instant is 01:30 on 15 July, a Wednesday either way this
      // particular date, so pick a date where the UTC and BST calendar dates
      // actually differ: 2026-07-16T23:30:00Z is UTC Thursday 16th, but BST
      // local time is 00:30 on Friday 17th — a genuinely different weekday.
      const startsAt = new Date('2026-07-16T23:30:00.000Z'); // UTC Thu, London Fri
      const candidate = await seedStaff(fx, 'fridayOnly', { availableDays: ['Friday'] });
      const fixture = await seedDeclinedOfferShift(fx, declining, { startsAt, endsAt: new Date(startsAt.getTime() + 4 * 3600 * 1000) });
      await runReplacementStaffCycle(adminDataSource, tenantContext, notificationService, auditService);
      const row = await withContext({ organisationId: fx.organisationId, workspaceId: fx.workspaceId, userId: fx.managerUserId }, (m) =>
        m.findOneByOrFail(ReplacementRequest, { declinedShiftAssignmentId: fixture.declinedAssignmentId }),
      );
      // Under the old `getUTCDay()` bug this shift would be classified as
      // Thursday and a Friday-only candidate would be wrongly excluded.
      expect(row.candidatesSnapshot.find((c) => c.staffProfileId === candidate.staffProfileId)).toBeDefined();
    });

    it('B6b: the same Friday-only candidate is correctly EXCLUDED from a genuinely Thursday (UTC and London agree) shift', async () => {
      const fx = await seedOrgFixture('eligB6b');
      const declining = await seedStaff(fx, 'declining');
      const startsAt = new Date('2026-07-16T10:00:00.000Z'); // 11:00 BST, still Thursday in both zones
      const candidate = await seedStaff(fx, 'fridayOnly', { availableDays: ['Friday'] });
      const fixture = await seedDeclinedOfferShift(fx, declining, { startsAt, endsAt: new Date(startsAt.getTime() + 4 * 3600 * 1000) });
      await runReplacementStaffCycle(adminDataSource, tenantContext, notificationService, auditService);
      const row = await withContext({ organisationId: fx.organisationId, workspaceId: fx.workspaceId, userId: fx.managerUserId }, (m) =>
        m.findOneByOrFail(ReplacementRequest, { declinedShiftAssignmentId: fixture.declinedAssignmentId }),
      );
      expect(row.candidatesSnapshot.find((c) => c.staffProfileId === candidate.staffProfileId)).toBeUndefined();
    });

    it('B7: no availableDays recorded at all — never penalised', async () => {
      const fx = await seedOrgFixture('eligB7');
      const declining = await seedStaff(fx, 'declining');
      const candidate = await seedStaff(fx, 'noPreference', { availableDays: null });
      const fixture = await seedDeclinedOfferShift(fx, declining);
      await runReplacementStaffCycle(adminDataSource, tenantContext, notificationService, auditService);
      const row = await withContext({ organisationId: fx.organisationId, workspaceId: fx.workspaceId, userId: fx.managerUserId }, (m) =>
        m.findOneByOrFail(ReplacementRequest, { declinedShiftAssignmentId: fixture.declinedAssignmentId }),
      );
      expect(row.candidatesSnapshot.find((c) => c.staffProfileId === candidate.staffProfileId)).toBeDefined();
    });

    it('B8: a candidate from a different organisation is never discovered', async () => {
      const fx = await seedOrgFixture('eligB8a');
      const otherOrg = await seedOrgFixture('eligB8b');
      const declining = await seedStaff(fx, 'declining');
      await seedStaff(otherOrg, 'wrongOrgCandidate');
      const fixture = await seedDeclinedOfferShift(fx, declining);
      await runReplacementStaffCycle(adminDataSource, tenantContext, notificationService, auditService);
      const row = await withContext({ organisationId: fx.organisationId, workspaceId: fx.workspaceId, userId: fx.managerUserId }, (m) =>
        m.findOneByOrFail(ReplacementRequest, { declinedShiftAssignmentId: fixture.declinedAssignmentId }),
      );
      expect(row.status).toBe(ReplacementRequestStatus.NO_CANDIDATES);
    });
  });

  // ===================================================================
  // C. Ranking
  // ===================================================================
  describe('C. ranking', () => {
    it('C1: an exact job-role match ranks above a non-matching role', async () => {
      const fx = await seedOrgFixture('rankC1');
      const declining = await seedStaff(fx, 'declining');
      const otherRole = await withContext({ organisationId: fx.organisationId, workspaceId: fx.workspaceId, userId: fx.managerUserId }, (m) =>
        m.save(JobRole, { organisationId: fx.organisationId, name: `Other ${randomUUID().slice(0, 6)}`, defaultRatePence: 1200, createdBy: fx.managerUserId, workspaceId: fx.workspaceId }),
      );
      const matching = await seedStaff(fx, 'matchingRole');
      const nonMatching = await seedStaff(fx, 'otherRole', { jobRoleId: otherRole.id });
      const fixture = await seedDeclinedOfferShift(fx, declining);
      await runReplacementStaffCycle(adminDataSource, tenantContext, notificationService, auditService);
      const row = await withContext({ organisationId: fx.organisationId, workspaceId: fx.workspaceId, userId: fx.managerUserId }, (m) =>
        m.findOneByOrFail(ReplacementRequest, { declinedShiftAssignmentId: fixture.declinedAssignmentId }),
      );
      const matchingIndex = row.candidatesSnapshot.findIndex((c) => c.staffProfileId === matching.staffProfileId);
      const nonMatchingIndex = row.candidatesSnapshot.findIndex((c) => c.staffProfileId === nonMatching.staffProfileId);
      expect(matchingIndex).toBeGreaterThanOrEqual(0);
      expect(nonMatchingIndex).toBeGreaterThanOrEqual(0);
      expect(matchingIndex).toBeLessThan(nonMatchingIndex);
    });

    it('C2: tied scores sort deterministically by staffProfileId ascending', async () => {
      const fx = await seedOrgFixture('rankC2');
      const declining = await seedStaff(fx, 'declining');
      // Two candidates with an identically-scoring profile (same job role, no other differentiating field).
      const a = await seedStaff(fx, 'tieA');
      const b = await seedStaff(fx, 'tieB');
      const fixture = await seedDeclinedOfferShift(fx, declining);
      await runReplacementStaffCycle(adminDataSource, tenantContext, notificationService, auditService);
      const row = await withContext({ organisationId: fx.organisationId, workspaceId: fx.workspaceId, userId: fx.managerUserId }, (m) =>
        m.findOneByOrFail(ReplacementRequest, { declinedShiftAssignmentId: fixture.declinedAssignmentId }),
      );
      const ids = [a.staffProfileId, b.staffProfileId].sort();
      const gotOrder = row.candidatesSnapshot.filter((c) => ids.includes(c.staffProfileId)).map((c) => c.staffProfileId);
      expect(gotOrder).toEqual(ids);
    });

    it('C3: the shortlist is bounded to 5 even with more eligible candidates', async () => {
      const fx = await seedOrgFixture('rankC3');
      const declining = await seedStaff(fx, 'declining');
      for (let i = 0; i < 7; i += 1) {
        await seedStaff(fx, `bulk${i}`);
      }
      const fixture = await seedDeclinedOfferShift(fx, declining);
      await runReplacementStaffCycle(adminDataSource, tenantContext, notificationService, auditService);
      const row = await withContext({ organisationId: fx.organisationId, workspaceId: fx.workspaceId, userId: fx.managerUserId }, (m) =>
        m.findOneByOrFail(ReplacementRequest, { declinedShiftAssignmentId: fixture.declinedAssignmentId }),
      );
      expect(row.candidatesSnapshot.length).toBeLessThanOrEqual(5);
    });
  });

  // ===================================================================
  // D. Manager recipient resolution
  // ===================================================================
  describe('D. manager recipient resolution', () => {
    it('D1: the assigning manager (assignedBy on the declined assignment) is the notified recipient', async () => {
      const fx = await seedOrgFixture('recipD1');
      const declining = await seedStaff(fx, 'declining');
      const fixture = await seedDeclinedOfferShift(fx, declining);
      await runReplacementStaffCycle(adminDataSource, tenantContext, notificationService, auditService);
      const row = await withContext({ organisationId: fx.organisationId, workspaceId: fx.workspaceId, userId: fx.managerUserId }, (m) =>
        m.findOneByOrFail(ReplacementRequest, { declinedShiftAssignmentId: fixture.declinedAssignmentId }),
      );
      expect(row.notifiedUserId).toBe(fx.managerUserId);
    });

    it('D2: a cross-org assignedBy anomaly is never trusted — falls back to shift.createdBy', async () => {
      const fx = await seedOrgFixture('recipD2a');
      const otherOrg = await seedOrgFixture('recipD2b');
      const declining = await seedStaff(fx, 'declining');
      const fixture = await seedDeclinedOfferShift(fx, declining, { assignedBy: otherOrg.managerUserId });
      await runReplacementStaffCycle(adminDataSource, tenantContext, notificationService, auditService);
      const row = await withContext({ organisationId: fx.organisationId, workspaceId: fx.workspaceId, userId: fx.managerUserId }, (m) =>
        m.findOneByOrFail(ReplacementRequest, { declinedShiftAssignmentId: fixture.declinedAssignmentId }),
      );
      // shift.createdBy defaults to fx.managerUserId in the fixture helper.
      expect(row.notifiedUserId).toBe(fx.managerUserId);
    });

    it('D3: no valid manager relationship — request still completes, notifiedUserId is null, never an arbitrary fallback', async () => {
      const fx = await seedOrgFixture('recipD3');
      const declining = await seedStaff(fx, 'declining');
      await withContext({ organisationId: fx.organisationId, workspaceId: fx.workspaceId, userId: fx.managerUserId }, (m) => m.update(User, { id: fx.managerUserId }, { status: UserStatus.DEACTIVATED }));
      const fixture = await seedDeclinedOfferShift(fx, declining);
      await runReplacementStaffCycle(adminDataSource, tenantContext, notificationService, auditService);
      const row = await withContext({ organisationId: fx.organisationId, workspaceId: fx.workspaceId, userId: fx.managerUserId }, (m) =>
        m.findOneByOrFail(ReplacementRequest, { declinedShiftAssignmentId: fixture.declinedAssignmentId }),
      );
      expect(row.notifiedUserId).toBeNull();
    });
  });

  // ===================================================================
  // E. Approval races — the central Phase 4 fix
  // ===================================================================
  describe('E. approval races', () => {
    it('E1: five concurrent approve() calls for five different candidates — exactly one wins, exactly one offer created', async () => {
      const fx = await seedOrgFixture('raceE1');
      const declining = await seedStaff(fx, 'declining');
      const fixture = await seedDeclinedOfferShift(fx, declining);
      const candidates = await Promise.all([0, 1, 2, 3, 4].map((i) => seedStaff(fx, `cand${i}`)));
      const snapshots = await Promise.all(candidates.map((c) => candidateSnapshot(c.staffProfileId)));
      const requestId = await seedReplacementRequest(fx, fixture, snapshots);

      const results = await raceAndReport(
        candidates.map((c) => () => replacementRequestService.approve(authCtx(fx), requestId, { staffProfileId: c.staffProfileId })),
      );
      const succeeded = results.filter((r) => r.ok);
      const failed = results.filter((r) => !r.ok);
      expect(succeeded).toHaveLength(1);
      expect(failed).toHaveLength(4);
      for (const f of failed) expect(f.error).toBeInstanceOf(ConflictException);

      const final = await getRequest(fx, requestId);
      expect(final!.status).toBe(ReplacementRequestStatus.OFFER_SENT);
      const offerCount = await withContext({ organisationId: fx.organisationId, workspaceId: fx.workspaceId, userId: fx.managerUserId }, (m) =>
        m.query<Array<{ count: string }>>(`SELECT count(*) FROM core.job_offer WHERE staff_profile_id = ANY($1::uuid[])`, [candidates.map((c) => c.staffProfileId)]),
      );
      expect(Number(offerCount[0]!.count)).toBe(1);
    });

    it('E2: approve racing reject — exactly one wins, the request ends in a single consistent terminal state', async () => {
      const fx = await seedOrgFixture('raceE2');
      const declining = await seedStaff(fx, 'declining');
      const fixture = await seedDeclinedOfferShift(fx, declining);
      const candidate = await seedStaff(fx, 'cand');
      const requestId = await seedReplacementRequest(fx, fixture, [await candidateSnapshot(candidate.staffProfileId)]);

      const results = await raceAndReport([
        () => replacementRequestService.approve(authCtx(fx), requestId, { staffProfileId: candidate.staffProfileId }),
        () => replacementRequestService.reject(authCtx(fx), requestId),
      ]);
      const succeeded = results.filter((r) => r.ok);
      expect(succeeded).toHaveLength(1);

      const final = await getRequest(fx, requestId);
      expect([ReplacementRequestStatus.OFFER_SENT, ReplacementRequestStatus.REJECTED]).toContain(final!.status);
    });

    it('E3: approve racing a shift cancellation — either the offer is sent XOR the request ends CANCELLED, never both, never neither', async () => {
      const fx = await seedOrgFixture('raceE3');
      const declining = await seedStaff(fx, 'declining');
      const fixture = await seedDeclinedOfferShift(fx, declining);
      const candidate = await seedStaff(fx, 'cand');
      const requestId = await seedReplacementRequest(fx, fixture, [await candidateSnapshot(candidate.staffProfileId)]);

      const cancelShift = () => withContext({ organisationId: fx.organisationId, workspaceId: fx.workspaceId, userId: fx.managerUserId }, (m) => m.update(Shift, fixture.shiftId, { status: ShiftStatus.CANCELLED }));
      const approve = () => replacementRequestService.approve(authCtx(fx), requestId, { staffProfileId: candidate.staffProfileId });
      await raceAndReport([approve, cancelShift]);

      const final = await getRequest(fx, requestId);
      const offerCount = await withContext({ organisationId: fx.organisationId, workspaceId: fx.workspaceId, userId: fx.managerUserId }, (m) =>
        m.query<Array<{ count: string }>>(`SELECT count(*) FROM core.job_offer WHERE staff_profile_id = $1`, [candidate.staffProfileId]),
      );
      const offersSent = Number(offerCount[0]!.count);
      if (final!.status === ReplacementRequestStatus.OFFER_SENT) {
        expect(offersSent).toBe(1);
      } else {
        expect(final!.status).toBe(ReplacementRequestStatus.CANCELLED);
        expect(offersSent).toBe(0);
      }
    });

    it('E3b: approving a request whose shift is ALREADY cancelled always ends CANCELLED, never sends an offer', async () => {
      const fx = await seedOrgFixture('raceE3b');
      const declining = await seedStaff(fx, 'declining');
      const fixture = await seedDeclinedOfferShift(fx, declining);
      const candidate = await seedStaff(fx, 'cand');
      const requestId = await seedReplacementRequest(fx, fixture, [await candidateSnapshot(candidate.staffProfileId)]);
      await withContext({ organisationId: fx.organisationId, workspaceId: fx.workspaceId, userId: fx.managerUserId }, (m) => m.update(Shift, fixture.shiftId, { status: ShiftStatus.CANCELLED }));

      await expect(replacementRequestService.approve(authCtx(fx), requestId, { staffProfileId: candidate.staffProfileId })).rejects.toBeInstanceOf(ConflictException);
      const final = await getRequest(fx, requestId);
      expect(final!.status).toBe(ReplacementRequestStatus.CANCELLED);
      const offerCount = await withContext({ organisationId: fx.organisationId, workspaceId: fx.workspaceId, userId: fx.managerUserId }, (m) =>
        m.query<Array<{ count: string }>>(`SELECT count(*) FROM core.job_offer WHERE staff_profile_id = $1`, [candidate.staffProfileId]),
      );
      expect(Number(offerCount[0]!.count)).toBe(0);
    });

    it('E3c: a shift already fully staffed before approval also ends the request CANCELLED', async () => {
      const fx = await seedOrgFixture('raceE3c');
      const declining = await seedStaff(fx, 'declining');
      const fixture = await seedDeclinedOfferShift(fx, declining);
      const candidate = await seedStaff(fx, 'cand');
      const requestId = await seedReplacementRequest(fx, fixture, [await candidateSnapshot(candidate.staffProfileId)]);
      await withContext({ organisationId: fx.organisationId, workspaceId: fx.workspaceId, userId: fx.managerUserId }, (m) => m.update(Shift, fixture.shiftId, { filledCount: 1, requiredCount: 1 }));

      await expect(replacementRequestService.approve(authCtx(fx), requestId, { staffProfileId: candidate.staffProfileId })).rejects.toBeInstanceOf(ConflictException);
      const final = await getRequest(fx, requestId);
      expect(final!.status).toBe(ReplacementRequestStatus.CANCELLED);
    });

    it('E4: the selected candidate becomes ineligible between shortlist and approval — retryable (request reverts, a different candidate can then succeed)', async () => {
      const fx = await seedOrgFixture('raceE4');
      const declining = await seedStaff(fx, 'declining');
      const fixture = await seedDeclinedOfferShift(fx, declining);
      const staleCandidate = await seedStaff(fx, 'stale');
      const freshCandidate = await seedStaff(fx, 'fresh');
      const requestId = await seedReplacementRequest(fx, fixture, [await candidateSnapshot(staleCandidate.staffProfileId), await candidateSnapshot(freshCandidate.staffProfileId)]);
      // The stale candidate is deactivated after being shortlisted.
      await withContext({ organisationId: fx.organisationId, workspaceId: fx.workspaceId, userId: fx.managerUserId }, (m) => m.update(User, { id: staleCandidate.userId }, { status: UserStatus.DEACTIVATED }));

      await expect(replacementRequestService.approve(authCtx(fx), requestId, { staffProfileId: staleCandidate.staffProfileId })).rejects.toBeInstanceOf(ConflictException);
      const afterFailedAttempt = await getRequest(fx, requestId);
      // Released back to a claimable state, NOT cancelled — the vacancy itself still exists.
      expect(afterFailedAttempt!.status).toBe(ReplacementRequestStatus.AWAITING_APPROVAL);

      const approved = await replacementRequestService.approve(authCtx(fx), requestId, { staffProfileId: freshCandidate.staffProfileId });
      expect(approved.status).toBe(ReplacementRequestStatus.OFFER_SENT);
      expect(approved.selectedStaffProfileId).toBe(freshCandidate.staffProfileId);
    });

    it('E5: a staffProfileId not present in the shortlist is rejected and the claim is released', async () => {
      const fx = await seedOrgFixture('raceE5');
      const declining = await seedStaff(fx, 'declining');
      const fixture = await seedDeclinedOfferShift(fx, declining);
      const notInShortlist = await seedStaff(fx, 'notlisted');
      const requestId = await seedReplacementRequest(fx, fixture, []);

      await expect(replacementRequestService.approve(authCtx(fx), requestId, { staffProfileId: notInShortlist.staffProfileId })).rejects.toBeInstanceOf(ConflictException);
      const final = await getRequest(fx, requestId);
      expect(final!.status).toBe(ReplacementRequestStatus.AWAITING_APPROVAL);
    });

    it('E6: approving an already OFFER_SENT request is rejected (409) and never creates a second offer', async () => {
      const fx = await seedOrgFixture('raceE6');
      const declining = await seedStaff(fx, 'declining');
      const fixture = await seedDeclinedOfferShift(fx, declining);
      const candidate = await seedStaff(fx, 'cand');
      const second = await seedStaff(fx, 'second');
      const requestId = await seedReplacementRequest(fx, fixture, [await candidateSnapshot(candidate.staffProfileId), await candidateSnapshot(second.staffProfileId)]);
      await replacementRequestService.approve(authCtx(fx), requestId, { staffProfileId: candidate.staffProfileId });

      await expect(replacementRequestService.approve(authCtx(fx), requestId, { staffProfileId: second.staffProfileId })).rejects.toBeInstanceOf(ConflictException);
      const offerCount = await withContext({ organisationId: fx.organisationId, workspaceId: fx.workspaceId, userId: fx.managerUserId }, (m) =>
        m.query<Array<{ count: string }>>(`SELECT count(*) FROM core.job_offer WHERE staff_profile_id = ANY($1::uuid[])`, [[candidate.staffProfileId, second.staffProfileId]]),
      );
      expect(Number(offerCount[0]!.count)).toBe(1);
    });

    it('E7: rejecting an already OFFER_SENT request is rejected (409)', async () => {
      const fx = await seedOrgFixture('raceE7');
      const declining = await seedStaff(fx, 'declining');
      const fixture = await seedDeclinedOfferShift(fx, declining);
      const candidate = await seedStaff(fx, 'cand');
      const requestId = await seedReplacementRequest(fx, fixture, [await candidateSnapshot(candidate.staffProfileId)]);
      await replacementRequestService.approve(authCtx(fx), requestId, { staffProfileId: candidate.staffProfileId });

      await expect(replacementRequestService.reject(authCtx(fx), requestId)).rejects.toBeInstanceOf(ConflictException);
    });

    it('E8: a NO_CANDIDATES request can still be approved once a manager finds/adds a valid candidate to the snapshot', async () => {
      const fx = await seedOrgFixture('raceE8');
      const declining = await seedStaff(fx, 'declining');
      const fixture = await seedDeclinedOfferShift(fx, declining);
      const candidate = await seedStaff(fx, 'cand');
      const requestId = await seedReplacementRequest(fx, fixture, [await candidateSnapshot(candidate.staffProfileId)], ReplacementRequestStatus.NO_CANDIDATES);
      const approved = await replacementRequestService.approve(authCtx(fx), requestId, { staffProfileId: candidate.staffProfileId });
      expect(approved.status).toBe(ReplacementRequestStatus.OFFER_SENT);
    });
  });

  // ===================================================================
  // F. OfferService integration
  // ===================================================================
  describe('F. OfferService integration', () => {
    it('F1: approval creates a real, canonical JobOffer (PENDING, correct staff/shift) and transitions the shift OPEN -> OFFERED', async () => {
      const fx = await seedOrgFixture('offerF1');
      const declining = await seedStaff(fx, 'declining');
      const fixture = await seedDeclinedOfferShift(fx, declining, { shiftStatus: ShiftStatus.OPEN });
      const candidate = await seedStaff(fx, 'cand');
      const requestId = await seedReplacementRequest(fx, fixture, [await candidateSnapshot(candidate.staffProfileId)]);

      const approved = await replacementRequestService.approve(authCtx(fx), requestId, { staffProfileId: candidate.staffProfileId });
      expect(approved.resultingOfferId).toBeTruthy();
      expect(approved.approvedBy).toBe(fx.managerUserId);
      expect(approved.approvedAt).toBeInstanceOf(Date);

      const offer = await withContext({ organisationId: fx.organisationId, workspaceId: fx.workspaceId, userId: fx.managerUserId }, (m) =>
        m.findOneByOrFail(JobOffer, { id: approved.resultingOfferId! }),
      );
      expect(offer.status).toBe(OfferStatus.PENDING);
      expect(offer.staffProfileId).toBe(candidate.staffProfileId);

      const shift = await withContext({ organisationId: fx.organisationId, workspaceId: fx.workspaceId, userId: fx.managerUserId }, (m) => m.findOneByOrFail(Shift, { id: fixture.shiftId }));
      expect(shift.status).toBe(ShiftStatus.OFFERED);
    });

    it('F2: an offer created via replacement approval is a normal ShiftAssignment (OFFERED) — the standard offer lifecycle, no special replacement-only state', async () => {
      const fx = await seedOrgFixture('offerF2');
      const declining = await seedStaff(fx, 'declining');
      const fixture = await seedDeclinedOfferShift(fx, declining);
      const candidate = await seedStaff(fx, 'cand');
      const requestId = await seedReplacementRequest(fx, fixture, [await candidateSnapshot(candidate.staffProfileId)]);
      const approved = await replacementRequestService.approve(authCtx(fx), requestId, { staffProfileId: candidate.staffProfileId });

      const assignment = await withContext({ organisationId: fx.organisationId, workspaceId: fx.workspaceId, userId: fx.managerUserId }, (m) =>
        m.findOneByOrFail(ShiftAssignment, { shiftId: fixture.shiftId, staffProfileId: candidate.staffProfileId }),
      );
      expect(assignment.status).toBe(ShiftAssignmentStatus.OFFERED);
      void approved;
    });
  });

  // ===================================================================
  // G. Tenant / RLS isolation and IDOR
  // ===================================================================
  describe('G. tenant isolation and IDOR', () => {
    it('G1: a manager from a DIFFERENT organisation approving the same id gets a 404, not a 403 (no disclosure)', async () => {
      const fx = await seedOrgFixture('rlsG1a');
      const otherOrg = await seedOrgFixture('rlsG1b');
      const declining = await seedStaff(fx, 'declining');
      const fixture = await seedDeclinedOfferShift(fx, declining);
      const candidate = await seedStaff(fx, 'cand');
      const requestId = await seedReplacementRequest(fx, fixture, [await candidateSnapshot(candidate.staffProfileId)]);

      await expect(replacementRequestService.approve(authCtx(otherOrg), requestId, { staffProfileId: candidate.staffProfileId })).rejects.toBeInstanceOf(NotFoundException);
      // Never actually resolved for org A either — the cross-org attempt changed nothing.
      const final = await getRequest(fx, requestId);
      expect(final!.status).toBe(ReplacementRequestStatus.AWAITING_APPROVAL);
    });

    it('G2: rejecting from a different organisation is also a 404', async () => {
      const fx = await seedOrgFixture('rlsG2a');
      const otherOrg = await seedOrgFixture('rlsG2b');
      const declining = await seedStaff(fx, 'declining');
      const fixture = await seedDeclinedOfferShift(fx, declining);
      const requestId = await seedReplacementRequest(fx, fixture, []);
      await expect(replacementRequestService.reject(authCtx(otherOrg), requestId)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('G3: a request is invisible with no tenant context bound at all — zero rows, never all rows', async () => {
      const fx = await seedOrgFixture('rlsG3');
      const declining = await seedStaff(fx, 'declining');
      const fixture = await seedDeclinedOfferShift(fx, declining);
      const requestId = await seedReplacementRequest(fx, fixture, []);

      const seenWithNoContext = await dataSource.transaction(async (m) => {
        await m.query(`SELECT set_config('rab.organisation_id', '', true)`);
        await m.query(`SELECT set_config('rab.workspace_id', '', true)`);
        await m.query(`SELECT set_config('rab.user_id', '', true)`);
        return m.query<Array<{ id: string }>>(`SELECT id FROM core.replacement_request WHERE id = $1`, [requestId]);
      });
      expect(seenWithNoContext).toHaveLength(0);
    });

    it('G4 (IDOR): changing :id to another tenant\'s real request id never approves or exposes it', async () => {
      const fx = await seedOrgFixture('rlsG4a');
      const otherOrg = await seedOrgFixture('rlsG4b');
      const otherDeclining = await seedStaff(otherOrg, 'declining');
      const otherFixture = await seedDeclinedOfferShift(otherOrg, otherDeclining);
      const otherCandidate = await seedStaff(otherOrg, 'cand');
      const otherRequestId = await seedReplacementRequest(otherOrg, otherFixture, [await candidateSnapshot(otherCandidate.staffProfileId)]);

      // fx's own manager, acting under fx's own tenant context, tries the other org's real id.
      await expect(replacementRequestService.approve(authCtx(fx), otherRequestId, { staffProfileId: otherCandidate.staffProfileId })).rejects.toBeInstanceOf(NotFoundException);
      const stillIntact = await getRequest(otherOrg, otherRequestId);
      expect(stillIntact!.status).toBe(ReplacementRequestStatus.AWAITING_APPROVAL);
    });

    it('G5: a workspace-scoped manager cannot approve a request belonging to a different workspace in the SAME organisation', async () => {
      const fx = await seedOrgFixture('rlsG5');
      const declining = await seedStaff(fx, 'declining');
      const fixture = await seedDeclinedOfferShift(fx, declining);
      const candidate = await seedStaff(fx, 'cand');
      const requestId = await seedReplacementRequest(fx, fixture, [await candidateSnapshot(candidate.staffProfileId)]);

      const otherWorkspaceManagerId = await withContext({ organisationId: fx.organisationId, workspaceId: null, userId: randomUUID() }, async (manager) => {
        const hash = await passwordHashing.hash('correct horse battery staple 1!');
        const userResult = await manager.insert(User, { organisationId: fx.organisationId, email: `otherws-${randomUUID()}@example.test`, passwordHash: hash, firstName: 'Other', lastName: 'Workspace', status: UserStatus.ACTIVE });
        const userId = userResult.identifiers[0]!.id as string;
        await manager.query(`SELECT set_config('rab.user_id', $1, true)`, [userId]);
        const workspace = await manager.save(ManagerWorkspace, { organisationId: fx.organisationId, ownerUserId: userId, name: `Other Workspace ${userId}`, subdomain: `otherws-${userId.slice(0, 8)}`, status: 'active' });
        await manager.insert(ManagerProfile, { organisationId: fx.organisationId, userId, type: ManagerType.INTERNAL, workspaceId: workspace.id });
        return { userId, workspaceId: workspace.id };
      });

      await expect(
        replacementRequestService.approve({ organisationId: fx.organisationId, workspaceId: otherWorkspaceManagerId.workspaceId, userId: otherWorkspaceManagerId.userId, role: 'manager' }, requestId, {
          staffProfileId: candidate.staffProfileId,
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ===================================================================
  // H. Audit exactly-once
  // ===================================================================
  describe('H. audit exactly-once under concurrency', () => {
    it('H1: five concurrent approvals produce exactly one REPLACEMENT_REQUEST_APPROVED audit row', async () => {
      const fx = await seedOrgFixture('auditH1');
      const declining = await seedStaff(fx, 'declining');
      const fixture = await seedDeclinedOfferShift(fx, declining);
      const candidates = await Promise.all([0, 1, 2, 3, 4].map((i) => seedStaff(fx, `cand${i}`)));
      const snapshots = await Promise.all(candidates.map((c) => candidateSnapshot(c.staffProfileId)));
      const requestId = await seedReplacementRequest(fx, fixture, snapshots);

      await raceAndReport(candidates.map((c) => () => replacementRequestService.approve(authCtx(fx), requestId, { staffProfileId: c.staffProfileId })));
      expect(await countAudit(fx, 'replacement_request.approved', requestId)).toBe(1);
    });

    it('H2: approving a request whose shift is already cancelled records exactly one CANCELLED_AT_APPROVAL audit row and zero APPROVED rows', async () => {
      const fx = await seedOrgFixture('auditH2');
      const declining = await seedStaff(fx, 'declining');
      const fixture = await seedDeclinedOfferShift(fx, declining);
      const candidate = await seedStaff(fx, 'cand');
      const requestId = await seedReplacementRequest(fx, fixture, [await candidateSnapshot(candidate.staffProfileId)]);
      await withContext({ organisationId: fx.organisationId, workspaceId: fx.workspaceId, userId: fx.managerUserId }, (m) => m.update(Shift, fixture.shiftId, { status: ShiftStatus.CANCELLED }));

      await expect(replacementRequestService.approve(authCtx(fx), requestId, { staffProfileId: candidate.staffProfileId })).rejects.toBeInstanceOf(ConflictException);
      expect(await countAudit(fx, 'replacement_request.cancelled_at_approval', requestId)).toBe(1);
      expect(await countAudit(fx, 'replacement_request.approved', requestId)).toBe(0);
    });

    it('H3: a rejected candidate attempt (not in shortlist) never records an approved audit row', async () => {
      const fx = await seedOrgFixture('auditH3');
      const declining = await seedStaff(fx, 'declining');
      const fixture = await seedDeclinedOfferShift(fx, declining);
      const notListed = await seedStaff(fx, 'notlisted');
      const requestId = await seedReplacementRequest(fx, fixture, []);
      await expect(replacementRequestService.approve(authCtx(fx), requestId, { staffProfileId: notListed.staffProfileId })).rejects.toBeInstanceOf(ConflictException);
      expect(await countAudit(fx, 'replacement_request.approved', requestId)).toBe(0);
    });

    it('H4: exactly one REPLACEMENT_REQUEST_REJECTED audit row is recorded on reject', async () => {
      const fx = await seedOrgFixture('auditH4');
      const declining = await seedStaff(fx, 'declining');
      const fixture = await seedDeclinedOfferShift(fx, declining);
      const requestId = await seedReplacementRequest(fx, fixture, []);
      await replacementRequestService.reject(authCtx(fx), requestId);
      expect(await countAudit(fx, 'replacement_request.rejected', requestId)).toBe(1);
    });
  });
});
