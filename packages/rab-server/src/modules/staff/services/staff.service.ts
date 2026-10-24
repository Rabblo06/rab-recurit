import { loadSystemRoleDefaultPermissions } from '../../identity/services/system-role-permissions';
import {
  ARCHIVE_TRANSITIONS,
  ArchiveState,
  archiveStateOf,
  assertTransition,
  EMPLOYMENT_STATUS_TRANSITIONS,
  EmailOutboxJobType,
  EmailOutboxStatusType,
  EmploymentStatus,
  generateSecurePassword,
  normalizeEmail,
  PermissionFlag,
  UserStatus,
} from '@rab/shared';
import { isEmailUnavailableViolation } from '../../../engine/filters/email-unavailable';
import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PermissionsService } from '../../../engine/core-modules/permissions/permissions.service';
import { EntityManager, In, QueryFailedError } from 'typeorm';

import { AccountInvite, EmailOutbox, Organisation, OrganisationMember, Permission, Role, RolePermission, User, UserRole } from '../../identity/entities';
import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { TenantContextService } from '../../../engine/core-modules/tenant/tenant-context.service';
import { WorkspaceMembershipService } from '../../../engine/core-modules/tenant/workspace-membership.service';
import { AccountInviteService, InvitationLifecycleStatus } from '../../../engine/core-modules/auth/services/account-invite.service';
import { AccountLifecycleService } from '../../../engine/core-modules/auth/services/account-lifecycle.service';
import { PasswordHashingService } from '../../../engine/core-modules/auth/services/password-hashing.service';
import { StepUpReauthService } from '../../../engine/core-modules/auth/services/step-up-reauth.service';
import { AuditAction, AuditService } from '../../../engine/core-modules/audit/audit.service';
import { EmailOutboxService } from '../../../engine/core-modules/email/email-outbox.service';
import { EmailQueueService } from '../../../engine/core-modules/email/email-queue.service';
import { RefreshTokenService } from '../../../engine/core-modules/auth/token/services/refresh-token.service';
import { SecurityVersionService } from '../../../engine/core-modules/auth/services/security-version.service';
import { ResourceScopeService } from '../../../engine/core-modules/resource-scope/resource-scope.service';
import { UserDeletionService } from '../../../engine/core-modules/user-deletion/user-deletion.service';
import { FileKind } from '../../../engine/core-modules/storage/file-kinds';
import { FileService } from '../../../engine/core-modules/storage/file.service';
import { StoredFile } from '../../../engine/core-modules/storage/entities/stored-file.entity';
import { PaginationDto, paginationSkipTake } from '../../../engine/dto/pagination.dto';
import { toIlikePattern } from '../../../engine/utils/ilike-pattern.util';
import { BulkEmailDto } from '../dto/bulk-email.dto';
import { AddNoteDto } from '../../identity/dto/add-note.dto';
import { ChangePendingEmailDto } from '../../identity/dto/change-pending-email.dto';
import { UserNoteItem, UserNoteService } from '../../identity/services/user-note.service';
import { AuditLogListItem } from '../../../engine/core-modules/audit/audit.service';
import { CreateStaffDto } from '../dto/create-staff.dto';
import { ListStaffDto } from '../dto/list-staff.dto';
import { ListVenueStaffDto } from '../dto/list-venue-staff.dto';
import { UpdateStaffDto } from '../dto/update-staff.dto';
import { AvailabilityService } from '../../scheduling/services/availability.service';
import { StaffProfile } from '../entities/staff-profile.entity';
import { MemberAccessPolicyService } from '../../identity/member-access/member-access-policy.service';
import { JobRole } from '../../scheduling/entities/job-role.entity';
import { Venue } from '../../venue/entities/venue.entity';
import { EmailChangeRequestResult, EmailChangeService } from '../../identity/services/email-change.service';
import { ChangeEmailDto } from '../../identity/dto/change-email.dto';

/**
 * Public sort key (already validated against `STAFF_SORT_FIELDS` by
 * `ListStaffDto`'s `@IsIn` before this is ever consulted — an unknown value
 * never reaches here) → the actual column/expression it orders by. The
 * allowlist-via-lookup-map pattern `rab-workforce-architecture.md`'s own
 * filter/sort design calls for: a client can never inject an arbitrary
 * identifier into `ORDER BY`, because the only strings that ever reach SQL
 * are the ones on the right-hand side here, never anything from the request.
 */
const STAFF_SORT_COLUMNS: Record<string, string> = {
  name: 'user.firstName',
  staffRef: 'sp.staffRef',
  email: 'user.email',
  defaultPayRatePence: 'sp.defaultPayRatePence',
  employmentStatus: 'sp.employmentStatus',
  createdAt: 'sp.createdAt',
};

export const STAFF_ROLE_KEY = 'staff';
export const STAFF_ROLE_PERMISSIONS = [PermissionFlag.OFFER_RESPOND, PermissionFlag.PAYSLIP_VIEW_OWN, PermissionFlag.ATTENDANCE_CLOCK];
const MAX_SEND_ATTEMPTS = 3;

export interface PendingInviteSummary {
  sendNumber: number;
  maxSendAttempts: number;
  expiresAt: Date;
  cleanupAt: Date | null;
}

/** Backs the detail panel's Email tab — see `listEmails`'s own doc comment. */
export interface EmailSummary {
  id: string;
  subject: string;
  status: string;
  createdAt: Date;
  sentAt: Date | null;
}

export interface StaffSummary {
  id: string;
  staffRef: string;
  email: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  dateOfBirth: string | null;
  avatarKey: string | null;
  employmentStatus: string;
  startDate: string | null;
  defaultPayRatePence: number;
  createdAt: Date;
  createdByName: string | null;
  accountStatus: string;
  invitationStatus: InvitationLifecycleStatus | null;
  mustResetPassword: boolean;
  pendingInvite: PendingInviteSummary | null;
  emergencyContactName: string | null;
  emergencyContactRelationship: string | null;
  emergencyContactPhone: string | null;
  jobRoleId: string | null;
  preferredName: string | null;
  employmentType: string | null;
  address: string | null;
  city: string | null;
  postcode: string | null;
  otherSkills: string | null;
  yearsExperience: number | null;
  availableDays: string[] | null;
  preferredShiftTimes: string | null;
  maxHoursPerWeek: number | null;
  rightToWorkStatus: string | null;
  documentType: string | null;
  expiryDate: string | null;
  languages: string[] | null;
  notes: string | null;
  /** Wave 5: set while the staff member is archived (leaver); null otherwise. */
  archivedAt: Date | null;
}

/**
 * What `GET /staff` (the Users table) actually returns — everything
 * `StaffSummary` has *except* the fields the table never renders and that
 * carry no reason to travel over the wire for every row on every page
 * load: `dateOfBirth` and the three `emergencyContact*` fields. The
 * Detail panel's own `GET /staff/:id` still returns the full
 * `StaffSummary` — this is a list-response minimization, not a
 * capability change.
 */
export type StaffListSummary = Omit<StaffSummary, 'dateOfBirth' | 'emergencyContactName' | 'emergencyContactRelationship' | 'emergencyContactPhone'>;

function toListSummary(full: StaffSummary): StaffListSummary {
  const { dateOfBirth: _dob, emergencyContactName: _ecn, emergencyContactRelationship: _ecr, emergencyContactPhone: _ecp, ...rest } = full;
  return rest;
}

@Injectable()
export class StaffService {
  @Inject(PermissionsService)
  private readonly directoryPermissions!: PermissionsService;
  @Inject(MemberAccessPolicyService)
  private readonly memberAccess!: MemberAccessPolicyService;
  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly workspaceMembership: WorkspaceMembershipService,
    private readonly accountLifecycle: AccountLifecycleService,
    private readonly accountInvite: AccountInviteService,
    private readonly auditService: AuditService,
    private readonly refreshTokenService: RefreshTokenService,
    private readonly securityVersion: SecurityVersionService,
    private readonly resourceScope: ResourceScopeService,
    private readonly userDeletion: UserDeletionService,
    private readonly emailOutbox: EmailOutboxService,
    private readonly emailQueue: EmailQueueService,
    private readonly userNote: UserNoteService,
    private readonly passwordHashing: PasswordHashingService,
    private readonly availabilityService: AvailabilityService,
    private readonly fileService: FileService,
    private readonly stepUpReauth: StepUpReauthService,
    private readonly emailChange: EmailChangeService,
  ) {}

  private async ensureStaffRole(manager: EntityManager, organisationId: string): Promise<Role> {
    let role = await manager.findOne(Role, { where: { organisationId, key: STAFF_ROLE_KEY } });
    if (role) return role;

    // Concurrency backstop: two Managers in the same organisation creating
    // their very first Staff member at the same instant can both miss the
    // `findOne` above and both reach here — confirmed in practice via this
    // session's own concurrency test (`role_organisation_id_key_key` 23505
    // on a plain `manager.insert`). `ON CONFLICT DO NOTHING` (the same
    // idiom already used throughout this codebase for idempotent
    // find-or-create — see ManagerService.addVenue, the platform_admin
    // grant commands) never raises, so unlike a caught 23505 it needs no
    // savepoint to keep using the caller's existing transaction afterwards.
    // The loser's statement blocks on the winner's uncommitted insert, then
    // sees the conflict and inserts nothing once the winner commits — by
    // which point the winner's RolePermission rows (below) are committed
    // and visible too, so the loser's plain re-select is always correct.
    const inserted: Array<{ id: string }> = await manager.query(
      `INSERT INTO core.role (organisation_id, key, name, is_system)
       VALUES ($1, $2, $3, true)
       ON CONFLICT (organisation_id, key) DO NOTHING
       RETURNING id`,
      [organisationId, STAFF_ROLE_KEY, 'Staff'],
    );
    if (inserted.length === 0) {
      return await manager.findOneByOrFail(Role, { organisationId, key: STAFF_ROLE_KEY });
    }
    role = await manager.findOneByOrFail(Role, { id: inserted[0]!.id });

    // Fail closed: never create the Staff system role missing any of its defaults (see loadSystemRoleDefaultPermissions).
    const permissions = await loadSystemRoleDefaultPermissions(manager, STAFF_ROLE_KEY, STAFF_ROLE_PERMISSIONS);
    if (permissions.length > 0) {
      await manager.insert(
        RolePermission,
        permissions.map((permission) => ({
          roleId: role!.id,
          permissionId: permission.id,
          organisationId,
        })),
      );
    }
    return role;
  }

  private toSummary(profile: StaffProfile, invite: AccountInvite | null | undefined, outboxStatus: EmailOutboxStatusType | null | undefined, createdByName: string | null): StaffSummary {
    const status = profile.user!.status;
    // See ManagerService.toSummary's identical comment — deliberately not
    // gated on revokedAt/acceptedAt; `invitationStatus` (below) is what
    // distinguishes pending/cancelled/expired/queued/sending/delivery_failed.
    const pendingInvite =
      invite && (status === UserStatus.INVITED || status === UserStatus.INVITE_EXPIRED)
        ? { sendNumber: invite.sendNumber, maxSendAttempts: MAX_SEND_ATTEMPTS, expiresAt: invite.expiresAt, cleanupAt: invite.cleanupAt ?? null }
        : null;
    return {
      id: profile.id,
      staffRef: profile.staffRef,
      email: profile.user!.email,
      firstName: profile.user!.firstName,
      lastName: profile.user!.lastName,
      phone: profile.user!.phone ?? null,
      dateOfBirth: profile.dateOfBirth ?? null,
      avatarKey: profile.user!.avatarFileId ?? null, // opaque FILE ID
      employmentStatus: profile.employmentStatus,
      startDate: profile.startDate ?? null,
      defaultPayRatePence: profile.defaultPayRatePence,
      createdAt: profile.createdAt,
      createdByName,
      accountStatus: status,
      invitationStatus: this.accountInvite.deriveInvitationStatus(status, invite ?? null, outboxStatus),
      mustResetPassword: profile.user!.mustResetPassword,
      pendingInvite,
      emergencyContactName: profile.emergencyContactName ?? null,
      emergencyContactRelationship: profile.emergencyContactRelationship ?? null,
      emergencyContactPhone: profile.emergencyContactPhone ?? null,
      jobRoleId: profile.jobRoleId ?? null,
      preferredName: profile.preferredName ?? null,
      employmentType: profile.employmentType ?? null,
      address: profile.address ?? null,
      city: profile.city ?? null,
      postcode: profile.postcode ?? null,
      otherSkills: profile.otherSkills ?? null,
      yearsExperience: profile.yearsExperience ?? null,
      availableDays: profile.availableDays ?? null,
      preferredShiftTimes: profile.preferredShiftTimes ?? null,
      maxHoursPerWeek: profile.maxHoursPerWeek ?? null,
      rightToWorkStatus: profile.rightToWorkStatus ?? null,
      documentType: profile.documentType ?? null,
      expiryDate: profile.expiryDate ?? null,
      languages: profile.languages ?? null,
      notes: profile.notes ?? null,
      archivedAt: profile.archivedAt ?? null,
    };
  }

  /** `created_by` is a bare user id — resolved to a display name here, batched, rather than per-row (avoids an N+1 across `list()`). A NULL/unrecoverable creator (see `StaffProfile.createdBy`'s own doc comment) resolves to `null`, never a guess. */
  private async resolveCreatedByNames(manager: EntityManager, profiles: StaffProfile[]): Promise<Map<string, string>> {
    const ids = [...new Set(profiles.map((p) => p.createdBy).filter((id): id is string => Boolean(id)))];
    if (ids.length === 0) return new Map();
    const rows = await manager.query<Array<{ id: string; first_name: string; last_name: string }>>(
      `SELECT id, first_name, last_name FROM core."user" WHERE id = ANY($1::uuid[])`,
      [ids],
    );
    return new Map(rows.map((r) => [r.id, `${r.first_name} ${r.last_name}`]));
  }

  /** Batch-fetches each profile's latest AccountInvite row (plus its outbox status) in one query — avoids an N+1 across `list()`. */
  private async toSummaries(manager: EntityManager, profiles: StaffProfile[]): Promise<StaffSummary[]> {
    const userIds = profiles.map((p) => p.userId);
    const latestByUser = await this.accountInvite.getLatestManyWithOutboxStatus(manager, userIds);
    const createdByNames = await this.resolveCreatedByNames(manager, profiles);
    return profiles.map((p) => {
      const found = latestByUser.get(p.userId);
      return this.toSummary(p, found?.invite ?? null, found?.outboxStatus ?? null, (p.createdBy && createdByNames.get(p.createdBy)) ?? null);
    });
  }

  /** Single-record equivalent of `toSummaries` — every non-list method (`get`, `update`, `deactivate`/`reactivate`) uses this, never the bare `toSummary(profile)`, so a pending account's badge/attempt-count/actions are correct everywhere the frontend reads them, not just in the list view. */
  private async toSummaryWithInvite(manager: EntityManager, profile: StaffProfile): Promise<StaffSummary> {
    const { invite, outboxStatus } = await this.accountInvite.getLatestWithOutboxStatus(manager, profile.userId);
    const createdByNames = await this.resolveCreatedByNames(manager, [profile]);
    return this.toSummary(profile, invite, outboxStatus, (profile.createdBy && createdByNames.get(profile.createdBy)) ?? null);
  }

  /**
   * A normal manager's private scope is "Staff I created" — Stage 2A Phase 2
   * retired the platform-admin org-wide bypass this used to have (a
   * platform admin's own ordinary `get()`/`update()` calls are scoped
   * exactly like anyone else's now; cross-manager visibility is available
   * only through the audited Admin Inspect mechanism, which rebinds
   * `ctx.userId` to the inspected target so this same check naturally
   * resolves against the target's own created-by scope). A profile with no
   * creator (created before this scoping existed — see
   * ResourceOwnershipSchema1786666700000) is deliberately invisible to
   * everyone until explicitly claimed, never guessed into a manager's
   * scope.
   */
  private assertOwned(ctx: AuthContext, profile: StaffProfile): void {
    if (profile.createdBy === ctx.userId) return;
    throw new NotFoundException('Staff member not found.');
  }

  /**
   * A `jobRoleId` on a create/update request was previously only checked
   * for organisation membership — a real gap: any manager could assign
   * another manager's *private* job role by guessing its UUID, even though
   * they can't see it in their own `GET /job-roles` list. Mirrors
   * `SchedulingService`'s own `assertJobRoleOwned` (the identical check
   * already applied to Shift creation for the same entity) rather than
   * inventing a second rule — a Venue Manager (or platform admin, via the
   * Admin Inspect rebind, which resolves scope against the inspected
   * target's own identity — never a blanket `resourceScope` bypass, per
   * Stage 2A Phase 2's removal of `{kind: 'admin'}` from `ResourceScope`
   * itself) may reference any org job role; an ordinary Manager only
   * their own.
   */
  private async assertJobRoleAccessible(manager: EntityManager, ctx: AuthContext, jobRoleId: string, rejectArchived = true): Promise<void> {
    // 404, not 400/403 — a job role outside the caller's scope is
    // indistinguishable from one that doesn't exist (CLAUDE.md, matching
    // SchedulingService.assertJobRoleOwned's identical choice for the
    // exact same entity).
    const jobRole = await manager.findOne(JobRole, { where: { id: jobRoleId, organisationId: ctx.organisationId! } });
    if (!jobRole) throw new NotFoundException('Job role not found.');
    const scope = await this.resourceScope.resolveTx(manager, ctx);
    const inScope = scope.kind === 'venue' || (scope.kind === 'owner' && jobRole.createdBy === ctx.userId);
    if (!inScope) throw new NotFoundException('Job role not found.');
    // Wave 5: a NEWLY chosen role must not be archived (keeping an already-assigned archived role on edit is fine).
    if (rejectArchived && jobRole.archivedAt) {
      throw new ConflictException({ code: 'JOB_ROLE_ARCHIVED', message: 'This job role is archived. Restore it before using it.' });
    }
  }

  /** Explicit saved team; active accounts in currently assigned workspaces only. */
  async venueDirectory(ctx: AuthContext, dto: ListVenueStaffDto = {}) {
    if (!(await this.directoryPermissions.userHasPermission(ctx, PermissionFlag.STAFF_VIEW))) {
      throw new ForbiddenException('Staff viewing is not permitted.');
    }
    return this.tenantContext.runInWorkspaceContext(ctx, async (manager) => {
      const scope = await this.resourceScope.resolveTx(manager, ctx);
      if (scope.kind !== 'venue') throw new NotFoundException('Directory not found.');
      if (!scope.venueIds.length) return { data: [], total: 0 };
      const query = manager.createQueryBuilder(StaffProfile, 'sp')
        .innerJoin(User, 'u', 'u.id = sp.userId')
        .where('sp.organisationId = :organisationId', { organisationId: ctx.organisationId })
        .andWhere('u.status = :activeStatus', { activeStatus: UserStatus.ACTIVE })
        .andWhere(`EXISTS (SELECT 1 FROM venue_manager_staff t
          JOIN core.manager_profile mp ON mp.id = t.manager_profile_id
          JOIN venue v ON v.workspace_id = t.workspace_id
          WHERE t.staff_profile_id = sp.id AND mp.user_id = :teamUserId
            AND v.id IN (:...venueIds)
            AND (:tag::text IS NULL OR (:tag = 'favourite' AND t.is_favourite) OR (:tag = 'emergency' AND t.is_emergency)))`,
          { teamUserId: ctx.userId, venueIds: scope.venueIds, tag: dto.tag ?? null })
        .leftJoin(JobRole, 'jr', 'jr.id = sp.jobRoleId');
      if (dto.q?.trim()) query.andWhere("(u.firstName ILIKE :q OR u.lastName ILIKE :q OR CONCAT(u.firstName, ' ', u.lastName) ILIKE :q)", { q: toIlikePattern(dto.q.trim()) });
      if (dto.status) query.andWhere('sp.employmentStatus = :status', { status: dto.status });
      const total = await query.getCount();
      const { skip, take } = paginationSkipTake(dto);
      const data = await query.select('sp.id', 'id')
        .addSelect('u.firstName', 'firstName').addSelect('u.lastName', 'lastName')
        .addSelect('sp.employmentStatus', 'employmentStatus')
        .addSelect('jr.name', 'jobRoleName')
        .addSelect(`COALESCE((SELECT t.is_favourite FROM venue_manager_staff t JOIN core.manager_profile mp ON mp.id = t.manager_profile_id
          WHERE t.staff_profile_id = sp.id AND mp.user_id = :teamUserId LIMIT 1), false)`, 'isFavourite')
        .addSelect(`COALESCE((SELECT t.is_emergency FROM venue_manager_staff t JOIN core.manager_profile mp ON mp.id = t.manager_profile_id
          WHERE t.staff_profile_id = sp.id AND mp.user_id = :teamUserId LIMIT 1), false)`, 'isEmergency')
        .orderBy('u.firstName', 'ASC').addOrderBy('sp.id', 'ASC')
        .offset(skip).limit(take).getRawMany();
      const { data: withAvailability } = await this.withAvailability(manager, data, dto);
      return { data: withAvailability, total };
    });
  }

  /**
   * One member of the calling Venue Manager's OWN team, operational fields only (no contact details, date of birth,
   * address, right-to-work, pay or emergency contacts). Anyone not on the caller's team (never assigned, removed, another
   * Venue Manager's, another workspace's, or not an active account) is 404.
   */
  async venueTeamMember(ctx: AuthContext, staffId: string) {
    if (!(await this.directoryPermissions.userHasPermission(ctx, PermissionFlag.STAFF_VIEW))) {
      throw new ForbiddenException('Staff viewing is not permitted.');
    }
    return this.tenantContext.runInWorkspaceContext(ctx, async (manager) => {
      const [row] = await manager.query(
        `SELECT sp.id, u.first_name AS "firstName", u.last_name AS "lastName", jr.name AS "jobRoleName",
            sp.employment_type AS "employmentType", sp.years_experience AS "yearsExperience", sp.other_skills AS "otherSkills",
            sp.available_days AS "availableDays", sp.preferred_shift_times AS "preferredShiftTimes",
            sp.max_hours_per_week AS "maxHoursPerWeek", t.is_favourite AS "isFavourite", t.is_emergency AS "isEmergency"
         FROM venue_manager_staff t
         JOIN core.manager_profile mp ON mp.id = t.manager_profile_id AND mp.user_id = $2 AND mp.type = 'venue'
         JOIN staff_profile sp ON sp.id = t.staff_profile_id AND sp.workspace_id = t.workspace_id
         JOIN core."user" u ON u.id = sp.user_id AND u.status = 'active'
         LEFT JOIN job_role jr ON jr.id = sp.job_role_id
         WHERE t.staff_profile_id = $1 AND t.organisation_id = $3 AND t.workspace_id = $4`,
        [staffId, ctx.userId, ctx.organisationId, ctx.workspaceId],
      );
      if (!row) throw new NotFoundException('Staff member not found.');
      const { otherSkills, ...rest } = row as { otherSkills: string | null } & Record<string, unknown>;
      const skills = (otherSkills ?? '').split(/[,\n;]/).map((s) => s.trim()).filter(Boolean);
      return { ...rest, skills, availableDays: (row.availableDays as string[] | null) ?? [] };
    });
  }

  /** The calling Venue Manager's own favourite / emergency-cover tags on one of their team rows. Not an assignment change. */
  async setVenueTeamTags(ctx: AuthContext, staffId: string, dto: { favourite?: boolean; emergency?: boolean }) {
    if (dto.favourite === undefined && dto.emergency === undefined) throw new BadRequestException('Nothing to update.');
    if (!(await this.directoryPermissions.userHasPermission(ctx, PermissionFlag.STAFF_VIEW))) {
      throw new ForbiddenException('Staff viewing is not permitted.');
    }
    return this.tenantContext.runInWorkspaceContext(ctx, async (manager) => {
      const rows: Array<{ isFavourite: boolean; isEmergency: boolean }> = await manager.query(
        `UPDATE venue_manager_staff t SET
            is_favourite = COALESCE($3::boolean, t.is_favourite), is_emergency = COALESCE($4::boolean, t.is_emergency)
         FROM core.manager_profile mp
         WHERE mp.id = t.manager_profile_id AND mp.user_id = $2 AND mp.type = 'venue'
           AND t.staff_profile_id = $1 AND t.organisation_id = $5 AND t.workspace_id = $6
         RETURNING t.is_favourite AS "isFavourite", t.is_emergency AS "isEmergency"`,
        [staffId, ctx.userId, dto.favourite ?? null, dto.emergency ?? null, ctx.organisationId, ctx.workspaceId],
      );
      // UPDATE ... RETURNING through TypeORM's raw query yields [rows, count].
      const result = Array.isArray(rows[0]) ? (rows[0] as unknown as Array<{ isFavourite: boolean; isEmergency: boolean }>) : rows;
      if (!result.length) throw new NotFoundException('Staff member not found.');
      return result[0];
    });
  }

  /**
   * Attaches a real, backend-derived `available` boolean to each already-
   * fetched row, in one bulk query (`AvailabilityService.findBusyStaffIds`)
   * — never one availability check per row. A no-op (returns `{ data }`
   * unchanged) when the caller didn't ask for a specific shift window,
   * since "available for what time?" is meaningless without one.
   */
  private async withAvailability<T extends { id: string }>(
    manager: EntityManager,
    data: T[],
    dto: Pick<ListVenueStaffDto, 'startAt' | 'endAt' | 'excludeShiftId'>,
  ): Promise<{ data: (T & { available?: boolean })[] }> {
    if (!dto.startAt || !dto.endAt) return { data };
    const busy = await this.availabilityService.findBusyStaffIds(
      manager,
      data.map((r) => r.id),
      new Date(dto.startAt),
      new Date(dto.endAt),
      dto.excludeShiftId,
    );
    return { data: data.map((row) => ({ ...row, available: !busy.has(row.id) })) };
  }

  async list(ctx: AuthContext, dto: ListStaffDto = {}): Promise<{ data: StaffListSummary[]; total: number }> {
    return this.tenantContext.runInWorkspaceContext(ctx, async (manager) => {
      // The caller's own staff — or, for a custom workspace-member only, their workspace owner's staff.
      const scope = await this.resourceScope.resolveTx(manager, ctx);
      const ownerUserId = scope.kind === 'owner' && scope.delegated ? scope.ownerUserId : ctx.userId;
      // Custom workspace-members: object / field / record-level role policy on top of the owner scope (no-op for others).
      const policy = await this.memberAccess.resolveTx(manager, ctx, 'staff');
      this.memberAccess.assertCanRead(policy);
      const visible = (field: string) => this.memberAccess.isFieldVisible(policy, field);
      const qb = manager
        .createQueryBuilder(StaffProfile, 'sp')
        .leftJoinAndSelect('sp.user', 'user')
        .where('sp.organisationId = :orgId', { orgId: ctx.organisationId! })
        .andWhere('sp.createdBy = :createdBy', { createdBy: ownerUserId });
      const recordFilter = this.memberAccess.qbWhere(policy, 'sp');
      qb.andWhere(recordFilter.sql, recordFilter.named);

      // Search, filters and sorting only ever touch fields the caller can see — a hidden field must not be probed
      // through a match, a filter or the row order.
      if (dto.q) {
        qb.andWhere(
          visible('email')
            ? '(user.firstName ILIKE :q OR user.lastName ILIKE :q OR user.email ILIKE :q OR sp.staffRef ILIKE :q)'
            : '(user.firstName ILIKE :q OR user.lastName ILIKE :q OR sp.staffRef ILIKE :q)',
          { q: toIlikePattern(dto.q) },
        );
      }
      if (dto.accountStatus) qb.andWhere('user.status = :accountStatus', { accountStatus: dto.accountStatus });
      if (dto.status) qb.andWhere('sp.employmentStatus = :status', { status: dto.status });
      // Wave 5: archived staff (leavers) are hidden unless "Show archived".
      if (!dto.includeArchived) qb.andWhere('sp.archivedAt IS NULL');
      if (dto.employmentType && visible('employmentType')) qb.andWhere('sp.employmentType = :employmentType', { employmentType: dto.employmentType });
      if (dto.jobRoleId && visible('jobRole')) qb.andWhere('sp.jobRoleId = :jobRoleId', { jobRoleId: dto.jobRoleId });
      if (dto.createdAtFrom) qb.andWhere('sp.createdAt >= :createdAtFrom', { createdAtFrom: dto.createdAtFrom });
      if (dto.createdAtTo) {
        // Exclusive upper bound one day past the given date, so a plain
        // `YYYY-MM-DD` "to" value includes every row created ON that date,
        // not just ones before its midnight.
        const exclusive = new Date(dto.createdAtTo);
        exclusive.setUTCDate(exclusive.getUTCDate() + 1);
        qb.andWhere('sp.createdAt < :createdAtToExclusive', { createdAtToExclusive: exclusive.toISOString() });
      }

      const sortKey = (dto.sort === 'email' && !visible('email')) || (dto.sort === 'defaultPayRatePence' && !visible('payRate')) ? 'createdAt' : dto.sort;
      const sortColumn = STAFF_SORT_COLUMNS[sortKey ?? 'createdAt'] ?? STAFF_SORT_COLUMNS.createdAt;
      qb.orderBy(sortColumn, (dto.direction ?? 'desc').toUpperCase() as 'ASC' | 'DESC');

      const { skip, take } = paginationSkipTake(dto);
      qb.skip(skip).take(take);

      const [profiles, total] = await qb.getManyAndCount();
      const summaries = await this.toSummaries(manager, profiles);
      return { data: summaries.map((s) => this.memberAccess.project(policy, toListSummary(s))), total };
    });
  }

  /**
   * `dto.userIds` are never trusted as authorization on their own — this
   * re-derives which of them the caller can actually reach with the exact
   * same `organisationId` + `createdBy: ctx.userId` predicate `list()`
   * already enforces, and anything outside it is silently dropped (never
   * a 403/404 revealing whether an id exists — matches this repo's own
   * "404 not 403" ethos, extended here to a filtered bulk operation
   * instead of a single lookup). Goes through the exact same durable-
   * outbox path every other email in this app uses (`EmailOutboxService.
   * enqueue` inside the transaction, `tryFastPublish` after commit) — no
   * synchronous SMTP call, no bypass of the dispatcher/worker.
   */
  async bulkEmail(ctx: AuthContext, dto: BulkEmailDto): Promise<{ queued: number; skipped: number }> {
    const rows = await this.tenantContext.runInWorkspaceContext(ctx, async (manager) => {
      const profiles = await manager.find(StaffProfile, {
        where: { organisationId: ctx.organisationId!, createdBy: ctx.userId, id: In(dto.userIds) },
        relations: { user: true },
      });
      const outboxRows = await Promise.all(
        profiles
          .filter((p) => p.user)
          .map((p) =>
            this.emailOutbox.enqueue(manager, {
              organisationId: ctx.organisationId!,
              jobType: EmailOutboxJobType.NOTIFICATION,
              recipientEmail: p.user!.email,
              targetUserId: p.userId,
              rendered: { subject: dto.subject, html: `<p>${dto.message}</p>`, text: dto.message },
              createdBy: ctx.userId,
            }),
          ),
      );
      await this.auditService.record(manager, ctx, AuditAction.EMAIL_SENT, {
        metadata: { bulkEmail: true, recipientCount: outboxRows.length, subject: dto.subject, skipped: dto.userIds.length - profiles.length },
      });
      return outboxRows;
    });

    for (const row of rows) {
      void this.emailOutbox.tryFastPublish((id, orgId) => this.emailQueue.publish(id, orgId), row);
    }

    return { queued: rows.length, skipped: dto.userIds.length - rows.length };
  }

  async get(ctx: AuthContext, id: string): Promise<StaffSummary> {
    return this.tenantContext.runInWorkspaceContext(ctx, async (manager) => {
      const profile = await manager.findOne(StaffProfile, { where: { id }, relations: { user: true } });
      if (!profile) throw new NotFoundException('Staff member not found.');
      // Read-only: a custom workspace-member may also read staff their workspace OWNER created (creator-based
      // ownership unchanged). Every write path keeps the strict `assertOwned` (the caller's own created_by).
      const scope = await this.resourceScope.resolveTx(manager, ctx);
      if (!(scope.kind === 'owner' && scope.delegated && profile.createdBy === scope.ownerUserId)) this.assertOwned(ctx, profile);
      const policy = await this.memberAccess.resolveTx(manager, ctx, 'staff');
      if (policy.restricted) {
        // A record outside the member's role (object denied or excluded by a record filter) is a 404, like any other
        // record outside the caller's scope.
        if (!policy.canRead) throw new NotFoundException('Staff member not found.');
        const recordFilter = this.memberAccess.qbWhere(policy, 'sp');
        const inScope = await manager
          .createQueryBuilder(StaffProfile, 'sp')
          .where('sp.id = :id', { id: profile.id })
          .andWhere(recordFilter.sql, recordFilter.named)
          .getExists();
        if (!inScope) throw new NotFoundException('Staff member not found.');
      }
      return this.memberAccess.project(policy, await this.toSummaryWithInvite(manager, profile));
    });
  }

  /**
   * Creates a Staff member in the PENDING (INVITED) state — no password is
   * generated or accepted here. Mirrors `ManagerService.create()` exactly;
   * see its own doc comment for the activation flow.
   */
  /**
   * The ONLY generator of Staff Reference values — server-side, never
   * client-supplied (see `CreateStaffDto`'s own doc comment). Canonical
   * format `STAFF <n>`, uppercase, one space; the parsing regex also
   * recognises the legacy `staffN` format (no space, lowercase) so existing
   * references are understood when computing the next number, without
   * rewriting them.
   *
   * Concurrency-safe via `pg_advisory_xact_lock`, keyed per-workspace — the
   * same idiom already used by `AttendanceService`'s `finalise:${shiftId}`
   * lock. Held for the whole scan-then-insert unit of work inside the
   * caller's transaction (xact-scoped: released automatically on commit or
   * rollback, so a crashed request can never leave it stuck), which is what
   * actually prevents two concurrent creates in the same Workspace from
   * computing the same "next" number — unlike the old `suggestNextStaffRef`,
   * which was explicitly documented as a non-authoritative UI suggestion
   * only. Scoped to `workspaceId`, not `organisationId`, matching Staff's own
   * Private Workspace ownership model (and the DB constraint — see
   * `StaffReferenceWorkspaceScopedUniqueness1786674500000`) — two different
   * Managers' private Workspaces never block each other.
   */
  private async generateStaffRef(manager: EntityManager, workspaceId: string): Promise<string> {
    await manager.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`staffref:${workspaceId}`]);
    const rows = await manager
      .createQueryBuilder(StaffProfile, 'sp')
      .select('sp.staff_ref', 'staffRef')
      .where('sp.workspace_id = :workspaceId', { workspaceId })
      .getRawMany<{ staffRef: string }>();
    const highest = rows.reduce((max, row) => {
      const match = /^staff\s*(\d+)$/i.exec(row.staffRef.trim());
      return match ? Math.max(max, parseInt(match[1]!, 10)) : max;
    }, 0);
    return `STAFF ${highest + 1}`;
  }

  async create(ctx: AuthContext, dto: CreateStaffDto): Promise<StaffSummary & { invite: { sendNumber: number; expiresAt: Date; queued: boolean } | null; emailQueued: boolean }> {
    this.resourceScope.assertHasWorkspace(ctx);
    const email = normalizeEmail(dto.email);

    try {
      return await this.tenantContext.runInWorkspaceContext(ctx, async (manager) => {
        const existingEmail = await manager.findOne(User, {
          where: { organisationId: ctx.organisationId!, email },
        });
        if (existingEmail) throw new ConflictException('A user with this email already exists.');

        if (dto.jobRoleId) {
          await this.assertJobRoleAccessible(manager, ctx, dto.jobRoleId);
        }

        // `generateStaffRef` acquires its workspace-scoped advisory lock
        // first, so this read of `ctx.workspaceId` is safe even if another
        // create for the same Workspace is racing this one.
        const staffRef = await this.generateStaffRef(manager, ctx.workspaceId!);

        // A Manager-reference credential only — never the staff member's
        // real one, never seen by either party. Hashed into
        // `temporaryPasswordHash`, never `passwordHash` itself (see that
        // column's own comment on the User entity for why the two must
        // never be the same column — it's what keeps AuthService.login()'s
        // first-login-activation check safe). `generateSecurePassword`
        // always satisfies `checkPasswordStrength` by construction, so no
        // separate strength check is needed here. The plaintext is never
        // assigned to a named variable beyond this expression — never
        // logged, never returned, never persisted anywhere but this hash.
        const temporaryPasswordHash = await this.passwordHashing.hash(generateSecurePassword());

        const userResult = await manager.insert(User, {
          organisationId: ctx.organisationId!,
          email,
          firstName: dto.firstName,
          lastName: dto.lastName,
          phone: dto.phone,
          temporaryPasswordHash,
          // status omitted — the column's own DEFAULT is UserStatus.INVITED.
        });
        const userId = userResult.identifiers[0]!.id as string;

        const role = await this.ensureStaffRole(manager, ctx.organisationId!);
        await manager.insert(UserRole, { userId, roleId: role.id, organisationId: ctx.organisationId! });
        // Increment 1 of the User/membership decoupling (see
        // organisation-member.entity.ts) — not read anywhere yet, just kept
        // complete going forward so a later cutover has no backfill gap.
        await manager.insert(OrganisationMember, { organisationId: ctx.organisationId!, userId });

        const profileResult = await manager.insert(StaffProfile, {
          organisationId: ctx.organisationId!,
          // Trusted server-side value only — never client-supplied (Private
          // Workspace migration, Stage 2A step 5). Nullable until every
          // Manager has completed real Workspace onboarding (step 11 tightens
          // this to NOT NULL once that's confirmed) — matches createdBy's own
          // existing nullable-until-enforced precedent.
          workspaceId: ctx.workspaceId ?? undefined,
          userId,
          staffRef,
          startDate: dto.startDate,
          defaultPayRatePence: dto.defaultPayRatePence ?? 0,
          dateOfBirth: dto.dateOfBirth,
          jobRoleId: dto.jobRoleId,
          emergencyContactName: dto.emergencyContactName,
          emergencyContactRelationship: dto.emergencyContactRelationship,
          emergencyContactPhone: dto.emergencyContactPhone,
          employmentStatus: EmploymentStatus.ACTIVE,
          createdBy: ctx.userId,
          preferredName: dto.preferredName,
          employmentType: dto.employmentType,
          address: dto.address,
          city: dto.city,
          postcode: dto.postcode,
          otherSkills: dto.otherSkills,
          yearsExperience: dto.yearsExperience,
          availableDays: dto.availableDays,
          preferredShiftTimes: dto.preferredShiftTimes,
          maxHoursPerWeek: dto.maxHoursPerWeek,
          rightToWorkStatus: dto.rightToWorkStatus,
          documentType: dto.documentType,
          expiryDate: dto.expiryDate,
          languages: dto.languages,
          notes: dto.notes,
        });
        // Hyper Workspace Phase 3: the new member belongs to the creating Manager's server-derived workspace, in this same transaction.
        await this.workspaceMembership.assignToWorkspace(manager, ctx, userId);

        const profile = await manager.findOneByOrFail(StaffProfile, {
          id: profileResult.identifiers[0]!.id as string,
        });
        profile.user = await manager.findOneByOrFail(User, { id: userId });

        // Account creation must never depend on, or fail because of, email
        // deliverability — checked synchronously (a cheap Redis read, never
        // a live SMTP round-trip) before deciding whether to create an
        // invite at all. If unavailable, skip cleanly: no AccountInvite row,
        // no EmailOutbox row — nothing durable that could fire a stale
        // invite later once the worker comes back. A Manager can send a
        // fresh one at any time via the existing "Resend invitation" action.
        const emailAvailable = await this.accountLifecycle.isEmailDeliveryAvailable();
        const invite = emailAvailable
          ? await this.accountLifecycle.sendAccountInvite(manager, ctx, { userId, email, createdBy: ctx.userId })
          : null;
        await this.auditService.record(manager, ctx, AuditAction.USER_CREATED, {
          targetUserId: userId,
          metadata: { emailQueued: emailAvailable },
        });
        const createdByNames = await this.resolveCreatedByNames(manager, [profile]);

        return {
          ...this.toSummary(profile, null, null, (profile.createdBy && createdByNames.get(profile.createdBy)) ?? null),
          // The invite row is now always durably committed before this
          // returns (A8) — delivery outcome is no longer known synchronously.
          // Null throughout when email was skipped at creation time.
          pendingInvite: invite
            ? { sendNumber: invite.sendNumber, maxSendAttempts: MAX_SEND_ATTEMPTS, expiresAt: invite.expiresAt, cleanupAt: null }
            : null,
          invitationStatus: invite ? ('queued' as const) : null,
          invite: invite ? { sendNumber: invite.sendNumber, expiresAt: invite.expiresAt, queued: invite.queued } : null,
          emailQueued: emailAvailable,
        };
      });
    } catch (e) {
      // `staffRef` collisions should be structurally impossible now (its
      // workspace-scoped advisory lock serializes every create in the same
      // Workspace) — this stays only as defense-in-depth against the email
      // pre-check's own residual race (two creates for the same email
      // landing between the pre-check and the insert), converting a raw
      // Postgres unique-violation (23505) into a controlled 409 instead of
      // an unhandled 500.
      // The cross-organisation email rule has its own generic response (AllExceptionsFilter) — never relabel it as a local duplicate.
      if (isEmailUnavailableViolation(e)) throw e;
      if (e instanceof QueryFailedError && (e as unknown as { code?: string }).code === '23505') {
        throw new ConflictException('A staff member with this reference or email already exists.');
      }
      throw e;
    }
  }

  /**
   * Creates the real Staff identity for an ACCEPTED email-first member invitation, inside the caller's
   * (`MemberInvitationService.accept`) transaction, which has already bound the invitation's organisation and
   * workspace and, as `ctx.userId`, the INVITER — the identity whose re-verified authority this creation runs
   * under, exactly as if they had pressed "Create" themselves (so `staff_profile_insert`'s RLS check that the
   * actor manages this workspace applies unchanged). The name and password hash are the RECIPIENT's own; no
   * placeholder value is ever written.
   *
   * Mirrors `create()`'s write set (user, staff role, organisation member, staff profile with a fresh workspace
   * reference, workspace membership) minus the parts that belong to the old flow: no temporary password, no
   * account_invite, no second email. The account stays INVITED with a password set — exactly the state
   * `activateAccount` leaves — and becomes ACTIVE at its first successful login.
   */
  async createFromAcceptedInvitation(
    manager: EntityManager,
    ctx: AuthContext,
    params: { email: string; firstName: string; lastName: string; passwordHash: string; acceptedAt: Date },
  ): Promise<string> {
    this.resourceScope.assertHasWorkspace(ctx);
    const staffRef = await this.generateStaffRef(manager, ctx.workspaceId!);
    const userResult = await manager.insert(User, {
      organisationId: ctx.organisationId!,
      email: params.email,
      firstName: params.firstName,
      lastName: params.lastName,
      passwordHash: params.passwordHash,
      mustResetPassword: false,
      // Possession of the emailed single-use token proves control of this address.
      emailVerifiedAt: params.acceptedAt,
    });
    const userId = userResult.identifiers[0]!.id as string;

    const role = await this.ensureStaffRole(manager, ctx.organisationId!);
    await manager.insert(UserRole, { userId, roleId: role.id, organisationId: ctx.organisationId! });
    await manager.insert(OrganisationMember, { organisationId: ctx.organisationId!, userId });
    await manager.insert(StaffProfile, {
      organisationId: ctx.organisationId!,
      workspaceId: ctx.workspaceId!,
      userId,
      staffRef,
      defaultPayRatePence: 0,
      employmentStatus: EmploymentStatus.ACTIVE,
      createdBy: ctx.userId,
    });
    await this.workspaceMembership.assignToWorkspace(manager, ctx, userId);
    return userId;
  }

  async update(ctx: AuthContext, id: string, dto: UpdateStaffDto): Promise<StaffSummary> {
    return this.tenantContext.runInWorkspaceContext(ctx, async (manager) => {
      const profile = await manager.findOne(StaffProfile, { where: { id }, relations: { user: true } });
      if (!profile) throw new NotFoundException('Staff member not found.');
      this.assertOwned(ctx, profile);

      if (dto.jobRoleId) {
        await this.assertJobRoleAccessible(manager, ctx, dto.jobRoleId, dto.jobRoleId !== profile.jobRoleId);
      }

      // `staffRef` is deliberately absent from `UpdateStaffDto` entirely —
      // immutable once generated by `create()` (see that method's own doc
      // comment). No raw-field path, named action, or client request can
      // change it here.
      const { firstName, lastName, phone, ...profileFields } = dto;
      if (firstName !== undefined || lastName !== undefined || phone !== undefined) {
        await manager.update(User, profile.userId, {
          ...(firstName !== undefined && { firstName }),
          ...(lastName !== undefined && { lastName }),
          ...(phone !== undefined && { phone }),
        });
      }
      const changedFields = [
        ...(firstName !== undefined ? ['firstName'] : []),
        ...(lastName !== undefined ? ['lastName'] : []),
        ...(phone !== undefined ? ['phone'] : []),
        ...Object.keys(profileFields),
      ];
      if (Object.keys(profileFields).length > 0) {
        try {
          await manager.update(StaffProfile, id, profileFields);
        } catch (e) {
          if (e instanceof QueryFailedError && (e as unknown as { code?: string }).code === '23505') {
            throw new ConflictException('A staff member with this reference already exists.');
          }
          throw e;
        }
      }

      // Field names only, never the values — several of these (dateOfBirth,
      // emergencyContact*) are sensitive personal data that don't belong in
      // an audit payload even as a "before/after," per CLAUDE.md's own
      // "never invent a business rule silently" spirit applied to privacy:
      // recording that DOB changed is useful for an admin review; recording
      // what it changed to/from is exposure with no real benefit.
      if (changedFields.length > 0) {
        await this.auditService.record(manager, ctx, AuditAction.PROFILE_UPDATED, {
          targetUserId: profile.userId,
          metadata: { fields: changedFields },
        });
      }

      const refreshed = await manager.findOneByOrFail(StaffProfile, { id });
      refreshed.user = await manager.findOneByOrFail(User, { id: profile.userId });
      return this.toSummaryWithInvite(manager, refreshed);
    });
  }

  /**
   * Suspend/Reactivate (via employment status) — applies only to an
   * already-ACTIVATED account, same rationale as `ManagerService.setActive`'s
   * identical guard (see its own doc comment). Without this, deactivating a
   * still-INVITED staff member force-set `User.status = SUSPENDED` with no
   * transition check at all, while the pending invitation's own token stayed
   * live and could still be accepted afterward (activateAccount() doesn't
   * check `User.status`) — an ambiguous, self-contradictory partial state
   * (employment INACTIVE, account ends up ACTIVE), not just a naming issue.
   */
  private async setEmploymentStatus(
    ctx: AuthContext,
    id: string,
    status: (typeof EmploymentStatus)[keyof typeof EmploymentStatus],
    onTransitioned?: (manager: EntityManager, profile: StaffProfile) => Promise<void>,
  ): Promise<StaffSummary> {
    return this.tenantContext.runInWorkspaceContext(ctx, async (manager) => {
      const profile = await manager.findOne(StaffProfile, { where: { id }, relations: { user: true } });
      if (!profile) throw new NotFoundException('Staff member not found.');
      this.assertOwned(ctx, profile);
      if (profile.user!.status === UserStatus.INVITED || profile.user!.status === UserStatus.INVITE_EXPIRED) {
        throw new ConflictException('This account has not been activated yet — use Cancel Invitation or Resend Invitation instead.');
      }
      assertTransition(EMPLOYMENT_STATUS_TRANSITIONS, profile.employmentStatus, status);
      // Wave 5 invariant "archived => inactive": an archived leaver is restored first, then reactivated.
      if (profile.archivedAt && status !== EmploymentStatus.INACTIVE) {
        throw new ConflictException({ code: 'STAFF_ARCHIVED', message: 'This staff member is archived. Restore them before reactivating.' });
      }
      await manager.update(StaffProfile, id, { employmentStatus: status });
      profile.employmentStatus = status;

      // Employment status alone controls nothing at the auth layer —
      // `User.status` is what `ActiveAccountGuard` actually checks on every
      // request, and what `StaffSummary.accountStatus` already reports to
      // the console. Deactivating staff without this line left the account
      // itself fully usable: existing access tokens kept working until they
      // expired, and refresh kept minting new ones indefinitely.
      if (status === EmploymentStatus.INACTIVE) {
        await manager.update(User, profile.userId, { status: UserStatus.SUSPENDED });
        await this.securityVersion.bumpUser(manager, profile.userId);
        profile.user!.status = UserStatus.SUSPENDED;
        await this.workspaceMembership.suspendForUser(manager, profile.userId);
        await this.refreshTokenService.revokeAllForUser(manager, profile.userId, 'account_suspended');
        await this.auditService.record(manager, ctx, AuditAction.ACCOUNT_SUSPENDED, { targetUserId: profile.userId });
      } else if (status === EmploymentStatus.ACTIVE && profile.user!.status === UserStatus.SUSPENDED) {
        await manager.update(User, profile.userId, { status: UserStatus.ACTIVE });
        await this.securityVersion.bumpUser(manager, profile.userId);
        profile.user!.status = UserStatus.ACTIVE;
        await this.workspaceMembership.reinstateForUser(manager, profile.userId);
        await this.auditService.record(manager, ctx, AuditAction.ACCOUNT_REACTIVATED, { targetUserId: profile.userId });
      }

      if (onTransitioned) await onTransitioned(manager, profile);
      return this.toSummaryWithInvite(manager, profile);
    });
  }

  async deactivate(ctx: AuthContext, id: string): Promise<StaffSummary> {
    await this.stepUpReauth.assertRecentStepUp(ctx, 'user.deactivate');
    return this.setEmploymentStatus(ctx, id, EmploymentStatus.INACTIVE, async (manager, profile) => {
      const organisation = await manager.findOneByOrFail(Organisation, { id: ctx.organisationId! });
      await this.accountLifecycle.sendSuspensionNotice(manager, ctx, {
        userId: profile.userId,
        email: profile.user!.email,
        firstName: profile.user!.firstName,
        organisationName: organisation.name,
      });
    });
  }

  async reactivate(ctx: AuthContext, id: string): Promise<StaffSummary> {
    await this.stepUpReauth.assertRecentStepUp(ctx, 'user.reactivate');
    return this.setEmploymentStatus(ctx, id, EmploymentStatus.ACTIVE);
  }

  /**
   * Named action `archiveStaff` (leaver). Layers: PermissionGuard(STAFF_DEACTIVATE) -> re-checked here -> strict owner
   * scope `assertOwned` (404 for another manager's, workspace's or organisation's staff) -> workspace RLS.
   * Preconditions (FLAGGED assumptions, see WAVE5_LANE_DATA_REPORT.md): the member is already deactivated
   * (`employment_status = inactive`, so the account is suspended and its sessions revoked — archiving never changes
   * access by itself), and has no upcoming or in-progress booking (offered / accepted / confirmed seat on a shift that
   * has not ended) — archiving would otherwise hide someone who is still due to work. Attendance, payroll records and
   * payslips are untouched and still show the name.
   */
  async archive(ctx: AuthContext, id: string): Promise<StaffSummary> {
    return this.tenantContext.runInWorkspaceContext(ctx, async (manager) => {
      if (!(await this.directoryPermissions.userHasPermissionTx(manager, ctx, PermissionFlag.STAFF_DEACTIVATE))) {
        throw new ForbiddenException('Archiving staff is not permitted.');
      }
      const profile = await manager.findOne(StaffProfile, { where: { id }, relations: { user: true } });
      if (!profile) throw new NotFoundException('Staff member not found.');
      this.assertOwned(ctx, profile);
      assertTransition(ARCHIVE_TRANSITIONS, archiveStateOf(profile.archivedAt), ArchiveState.ARCHIVED);
      if (profile.employmentStatus !== EmploymentStatus.INACTIVE) {
        throw new ConflictException({ code: 'STAFF_NOT_DEACTIVATED', message: 'Deactivate this staff member before archiving them.' });
      }
      const [{ upcoming }] = await manager.query<Array<{ upcoming: number }>>(
        `SELECT count(*)::int AS upcoming FROM shift_assignment sa JOIN shift s ON s.id = sa.shift_id
          WHERE sa.staff_profile_id = $1 AND sa.status IN ('offered', 'staff_accepted', 'confirmed')
            AND s.status NOT IN ('cancelled', 'completed', 'declined') AND s.ends_at > now()`,
        [profile.id],
      );
      if (upcoming > 0) {
        throw new ConflictException({ code: 'STAFF_HAS_UPCOMING_WORK', message: 'This staff member still has upcoming or open bookings. Resolve them before archiving.' });
      }
      await manager.update(StaffProfile, id, { archivedAt: () => 'now()', archivedBy: ctx.userId } as never);
      await this.auditService.record(manager, ctx, AuditAction.STAFF_ARCHIVED, {
        entityType: 'staff_profile', entityId: id, targetUserId: profile.userId, metadata: { staffRef: profile.staffRef },
      });
      const reloaded = await manager.findOneOrFail(StaffProfile, { where: { id }, relations: { user: true } });
      return this.toSummaryWithInvite(manager, reloaded);
    });
  }

  /**
   * Named action `restoreStaff`. Same layers as `archive`. The member comes back still deactivated (reactivate is a
   * separate, audited action). No unique conflict is possible: staff_ref and user_id stay held while archived (contract §3).
   */
  async restore(ctx: AuthContext, id: string): Promise<StaffSummary> {
    return this.tenantContext.runInWorkspaceContext(ctx, async (manager) => {
      if (!(await this.directoryPermissions.userHasPermissionTx(manager, ctx, PermissionFlag.STAFF_DEACTIVATE))) {
        throw new ForbiddenException('Restoring staff is not permitted.');
      }
      const profile = await manager.findOne(StaffProfile, { where: { id }, relations: { user: true } });
      if (!profile) throw new NotFoundException('Staff member not found.');
      this.assertOwned(ctx, profile);
      assertTransition(ARCHIVE_TRANSITIONS, archiveStateOf(profile.archivedAt), ArchiveState.ACTIVE);
      await manager.update(StaffProfile, id, { archivedAt: null, archivedBy: null });
      await this.auditService.record(manager, ctx, AuditAction.STAFF_RESTORED, {
        entityType: 'staff_profile', entityId: id, targetUserId: profile.userId, metadata: { staffRef: profile.staffRef },
      });
      const reloaded = await manager.findOneOrFail(StaffProfile, { where: { id }, relations: { user: true } });
      return this.toSummaryWithInvite(manager, reloaded);
    });
  }

  /**
   * Admin-triggered reset — the admin never sees or sets the target's new
   * password, only a fresh one-time setup link goes out. See
   * `AccountLifecycleService.adminResetPassword`.
   */
  async resetPassword(ctx: AuthContext, id: string): Promise<void> {
    await this.stepUpReauth.assertRecentStepUp(ctx, 'user.password_reset');
    return this.tenantContext.runInWorkspaceContext(ctx, async (manager) => {
      const profile = await manager.findOne(StaffProfile, { where: { id }, relations: { user: true } });
      if (!profile) throw new NotFoundException('Staff member not found.');
      this.assertOwned(ctx, profile);
      if (profile.user!.status === UserStatus.INVITED || profile.user!.status === UserStatus.INVITE_EXPIRED) {
        throw new ConflictException('This account has not been activated yet — use Resend Invitation instead.');
      }

      const organisation = await manager.findOneByOrFail(Organisation, { id: ctx.organisationId! });
      await this.accountLifecycle.adminResetPassword(manager, ctx, {
        targetUserId: profile.userId,
        targetEmail: profile.user!.email,
        targetFirstName: profile.user!.firstName,
        organisationName: organisation.name,
      });
    });
  }

  private async findPendingProfileOrFail(manager: EntityManager, ctx: AuthContext, id: string): Promise<StaffProfile> {
    const profile = await manager.findOne(StaffProfile, { where: { id }, relations: { user: true } });
    if (!profile) throw new NotFoundException('Staff member not found.');
    this.assertOwned(ctx, profile);
    if (profile.user!.status !== UserStatus.INVITED && profile.user!.status !== UserStatus.INVITE_EXPIRED) {
      throw new ConflictException('This account is not a pending invitation.');
    }
    return profile;
  }

  /** "Resend Invitation" — see `ManagerService.resendInvite`'s own doc comment (identical semantics, mirrored here). */
  async resendInvite(ctx: AuthContext, id: string): Promise<{ sendNumber: number; expiresAt: Date; queued: boolean }> {
    return this.tenantContext.runInWorkspaceContext(ctx, async (manager) => {
      const profile = await this.findPendingProfileOrFail(manager, ctx, id);
      const invite = await this.accountLifecycle.sendAccountInvite(manager, ctx, {
        userId: profile.userId,
        email: profile.user!.email,
        createdBy: ctx.userId,
      });
      await this.auditService.record(manager, ctx, AuditAction.INVITE_RESENT, {
        targetUserId: profile.userId,
        metadata: { sendNumber: invite.sendNumber },
      });
      return invite;
    });
  }

  /** Corrects a wrong pending email before activation — see `ManagerService.changePendingEmail`'s own doc comment for the count-reset trade-off (identical decision, mirrored here). */
  async changePendingEmail(ctx: AuthContext, id: string, dto: ChangePendingEmailDto): Promise<{ sendNumber: number; expiresAt: Date; queued: boolean }> {
    await this.stepUpReauth.assertRecentStepUp(ctx, 'user.pending_email.change');
    const newEmail = normalizeEmail(dto.email);
    return this.tenantContext.runInWorkspaceContext(ctx, async (manager) => {
      const profile = await this.findPendingProfileOrFail(manager, ctx, id);
      if (newEmail === profile.user!.email) {
        throw new BadRequestException('This is already the pending email for this account.');
      }
      const existingEmail = await manager.findOne(User, { where: { organisationId: ctx.organisationId!, email: newEmail } });
      if (existingEmail) throw new ConflictException('A user with this email already exists.');

      await this.accountInvite.revokeActive(manager, profile.userId);
      // Same reasoning as cancelInvite()'s password-null step: if this
      // account already activated (password set) against the OLD email
      // before the correction, that password must not silently keep
      // working post-change — null it so the fresh invite below is the
      // only way in again.
      // No "AND password_hash IS NOT NULL" guard — rab_app has zero SELECT
      // privilege on this column (RevokeUserPasswordHashSelectFromApp), so a
      // WHERE clause that reads it would itself be denied. Unconditional
      // NULL is idempotent regardless of the column's current value.
      await manager.query('UPDATE core."user" SET password_hash = NULL WHERE id = $1', [profile.userId]);
      await manager.update(User, profile.userId, { email: newEmail });
      await this.auditService.record(manager, ctx, AuditAction.INVITE_PENDING_EMAIL_CHANGED, {
        targetUserId: profile.userId,
        metadata: { from: profile.user!.email, to: newEmail },
      });

      return this.accountLifecycle.sendAccountInvite(manager, ctx, { userId: profile.userId, email: newEmail, createdBy: ctx.userId });
    });
  }

  /**
   * Revokes the active token — `User.status` is deliberately left as
   * INVITED (see `ManagerService.cancelInvite`'s doc comment for why:
   * a cancelled invite is not an account state, and touching status here
   * previously broke Re-invite/Reactivate; do not reintroduce that).
   *
   * ONE addition beyond the token revoke: if the account already has a
   * password set (they completed /auth/activate-account but haven't
   * logged in yet), also null it back out. `revokeActive()`'s own query
   * only ever matches an unaccepted invite (`accepted_at IS NULL`) — once
   * a password exists, revoking the token alone is a no-op, and
   * `AuthService.login()`'s INVITED-with-a-password branch would still let
   * them in and self-activate regardless of this "cancel." Nulling the
   * password (rather than changing `status`, which would need a status
   * value with no valid way back — the exact dead-end already identified
   * and reverted below) puts the account back to a genuine
   * no-credential PENDING state, cleanly re-invitable exactly as if
   * activation had never happened.
   */
  async cancelInvite(ctx: AuthContext, id: string): Promise<void> {
    return this.tenantContext.runInWorkspaceContext(ctx, async (manager) => {
      const profile = await this.findPendingProfileOrFail(manager, ctx, id);
      await this.accountInvite.revokeActive(manager, profile.userId);
      // No "AND password_hash IS NOT NULL" guard — rab_app has zero SELECT
      // privilege on this column (RevokeUserPasswordHashSelectFromApp), so a
      // WHERE clause that reads it would itself be denied. Unconditional
      // NULL is idempotent regardless of the column's current value.
      await manager.query('UPDATE core."user" SET password_hash = NULL WHERE id = $1', [profile.userId]);
      await this.auditService.record(manager, ctx, AuditAction.INVITE_CANCELLED, { targetUserId: profile.userId });
    });
  }

  /**
   * Unified "change email" mutation — the single path both a pending and
   * an activated account use, and the same one the General field's inline
   * hover-edit calls directly (there is no separate "Change email" button
   * any more — editing the field itself is the one workflow). Deliberately
   * does NOT touch the invitation token or send anything, even for a
   * pending account: correcting a typo is a plain data edit; the person
   * explicitly clicks "Resend invitation" afterward to actually dispatch
   * mail, matching this repo's own "no raw status/action bundling" spirit
   * applied to invites too — see `resendInvite()`, which already reads
   * `profile.user.email` fresh at send time, so it picks up whatever this
   * method just wrote with no extra plumbing.
   *
   * SECURITY TRADE-OFF: for a still-pending account, the previously-sent
   * invite email (already delivered to the OLD address) keeps its token
   * valid until the next Resend/Cancel revokes it (both already do this
   * unconditionally — `AccountInviteService.commit()`/`revokeActive()`).
   * Before this method existed, `changePendingEmail` revoked that token
   * synchronously in the same request as the correction. This narrows that
   * guarantee to "revoked by the next explicit send/cancel action," not
   * "revoked immediately on edit" — accepted because the alternative
   * (auto-resending on every keystroke-driven correction) is exactly the
   * coupling this change removes, and the exposure window is bounded by
   * the admin's own next action, not indefinite.
   */
  async changeEmail(ctx: AuthContext, id: string, dto: ChangeEmailDto): Promise<{ email: string } | EmailChangeRequestResult> {
    await this.stepUpReauth.assertRecentStepUp(ctx, 'user.email.change');
    const outcome = await this.tenantContext.runInWorkspaceContext(ctx, async (manager) => {
      const profile = await manager.findOne(StaffProfile, { where: { id }, relations: { user: true } });
      if (!profile) throw new NotFoundException('Staff member not found.');
      this.assertOwned(ctx, profile);

      const newEmail = normalizeEmail(dto.email);
      if (newEmail === profile.user!.email) {
        throw new BadRequestException('This is already this account\'s email.');
      }
      // CF-04: only a never-activated (INVITED) account keeps the direct correction path — it holds no credential and no
      // data. Any account that can sign in goes through the verified change (EmailChangeService), and a suspended or
      // deactivated one is refused there, so a takeover cannot be staged ahead of a reactivation.
      if (profile.user!.status !== UserStatus.INVITED) return { verify: true as const, userId: profile.userId };

      const existingEmail = await manager.findOne(User, { where: { organisationId: ctx.organisationId!, email: newEmail } });
      if (existingEmail) throw new ConflictException('A user with this email already exists.');

      await manager.update(User, profile.userId, { email: newEmail });
      await this.auditService.record(manager, ctx, AuditAction.PROFILE_UPDATED, {
        targetUserId: profile.userId,
        metadata: { field: 'email', from: profile.user!.email, to: newEmail },
      });
      return { verify: false as const, email: newEmail };
    });
    if (outcome.verify) {
      return this.emailChange.request(ctx, { targetUserId: outcome.userId, newEmail: dto.email, currentPassword: dto.currentPassword, requiredPermission: PermissionFlag.STAFF_EDIT });
    }
    return { email: outcome.email };
  }

  /** Backs the detail panel's Timeline tab. */
  async getTimeline(ctx: AuthContext, id: string): Promise<AuditLogListItem[]> {
    const profile = await this.tenantContext.runInWorkspaceContext(ctx, async (manager) => {
      const p = await manager.findOne(StaffProfile, { where: { id } });
      if (!p) throw new NotFoundException('Staff member not found.');
      this.assertOwned(ctx, p);
      return p;
    });
    return this.auditService.listForUser(ctx, profile.userId);
  }

  /** Backs the detail panel's Note tab. */
  async listNotes(ctx: AuthContext, id: string): Promise<UserNoteItem[]> {
    return this.tenantContext.runInWorkspaceContext(ctx, async (manager) => {
      const profile = await manager.findOne(StaffProfile, { where: { id } });
      if (!profile) throw new NotFoundException('Staff member not found.');
      this.assertOwned(ctx, profile);
      return this.userNote.list(manager, ctx, profile.userId);
    });
  }

  async addNote(ctx: AuthContext, id: string, dto: AddNoteDto): Promise<UserNoteItem> {
    return this.tenantContext.runInWorkspaceContext(ctx, async (manager) => {
      const profile = await manager.findOne(StaffProfile, { where: { id } });
      if (!profile) throw new NotFoundException('Staff member not found.');
      this.assertOwned(ctx, profile);
      return this.userNote.add(manager, ctx, profile.userId, dto.body);
    });
  }

  /**
   * Backs the detail panel's Email tab — real outbound history, never a
   * fabricated inbox. Reuses `EmailOutbox` as-is (no new table): every email
   * this app has ever sent this person, whatever `jobType` queued it
   * (invite, bulk email, etc.), newest first. `status` is passed through
   * unmapped — the frontend must never render anything but the genuine
   * `EmailOutboxStatus` value as "Sent".
   */
  async listEmails(ctx: AuthContext, id: string): Promise<EmailSummary[]> {
    return this.tenantContext.runInWorkspaceContext(ctx, async (manager) => {
      const profile = await manager.findOne(StaffProfile, { where: { id } });
      if (!profile) throw new NotFoundException('Staff member not found.');
      this.assertOwned(ctx, profile);
      const rows = await manager.find(EmailOutbox, {
        where: { targetUserId: profile.userId },
        order: { createdAt: 'DESC' },
      });
      return rows.map((r) => ({
        id: r.id,
        subject: r.renderedSubject,
        status: r.status,
        createdAt: r.createdAt,
        sentAt: r.sentAt ?? null,
      }));
    });
  }

  /**
   * Permanent removal — additional to Suspend/Reactivate, never a
   * replacement (B1). Same creator-private authorization every other Staff
   * mutation here already uses (`assertOwned`) — Manager A can never delete
   * Manager B's staff by guessing an id, matching how they already can't
   * view/edit/deactivate them. `UserDeletionService.assertCanDelete` is the
   * actual safety gate (self-delete, platform admin, owned workspace,
   * protected operational history — shift assignments, offers, attendance).
   *
   * P2.8 — step-up reauth checked FIRST, before even loading the target:
   * a hijacked-but-live session alone can never delete a user.
   */
  async deleteUser(ctx: AuthContext, id: string, currentPassword: string): Promise<void> {
    await this.stepUpReauth.assertCurrentPassword(ctx, currentPassword);
    return this.tenantContext.runInWorkspaceContext(ctx, async (manager) => {
      const profile = await manager.findOne(StaffProfile, { where: { id }, relations: { user: true } });
      if (!profile) throw new NotFoundException('Staff member not found.');
      this.assertOwned(ctx, profile);

      await this.userDeletion.assertCanDelete(manager, ctx, profile.userId);
      await this.userDeletion.deleteUser(manager, ctx, profile.userId, profile.user!.email);
    });
  }

  /** Tombstones the replaced avatar (row kept as `DELETED`); its object is purged later by `storage:reconcile` — mirrors `ProfileService`'s own identical private helper for the self-service case. */
  private async retireAvatar(manager: EntityManager, fileId: string | null | undefined): Promise<void> {
    if (!fileId) return;
    const file = await manager.findOne(StoredFile, { where: { id: fileId } });
    if (file) await this.fileService.tombstone(manager, file, { removeObject: false });
  }

  /**
   * Manager-initiated Staff avatar upload — there was previously no way to
   * set one at all (`avatarKey` was a read-only projection of
   * `User.avatarFileId`; nothing ever wrote it for a Staff target). Mirrors
   * `ProfileService.uploadAvatar`'s exact store-new → swap-pointer →
   * tombstone-old sequencing, with one addition: `assertOwned` first, the
   * same creator-private gate every other Staff mutation here already
   * uses — a Manager can never set another Manager's Staff member's avatar,
   * and the failure is 404 (record not found), never 403, matching every
   * other cross-Manager attempt against this entity.
   */
  async uploadAvatar(ctx: AuthContext, id: string, buffer: Buffer): Promise<{ avatarKey: string }> {
    return this.tenantContext.runInWorkspaceContext(ctx, async (manager) => {
      const profile = await manager.findOne(StaffProfile, { where: { id }, relations: { user: true } });
      if (!profile) throw new NotFoundException('Staff member not found.');
      this.assertOwned(ctx, profile);

      const before = profile.user!.avatarFileId;
      const file = await this.fileService.store(manager, {
        kind: FileKind.PROFILE_IMAGE,
        organisationId: ctx.organisationId!,
        workspaceId: ctx.workspaceId ?? null,
        resourceType: 'user',
        resourceId: profile.userId,
        buffer,
        createdBy: ctx.userId,
      });
      await manager.update(User, profile.userId, { avatarFileId: file.id });
      await this.retireAvatar(manager, before);
      await this.auditService.record(manager, ctx, AuditAction.FILE_UPLOADED, { entityType: 'stored_file', entityId: file.id, metadata: { kind: file.kind, sizeBytes: file.sizeBytes } });
      await this.auditService.record(manager, ctx, AuditAction.PROFILE_UPDATED, {
        targetUserId: profile.userId,
        metadata: { fields: ['avatar'] },
      });
      return { avatarKey: file.id };
    });
  }

  /** Removes a Staff member's avatar — same ownership gate as `uploadAvatar`. */
  async removeAvatar(ctx: AuthContext, id: string): Promise<{ avatarKey: string | null }> {
    return this.tenantContext.runInWorkspaceContext(ctx, async (manager) => {
      const profile = await manager.findOne(StaffProfile, { where: { id }, relations: { user: true } });
      if (!profile) throw new NotFoundException('Staff member not found.');
      this.assertOwned(ctx, profile);

      const before = profile.user!.avatarFileId;
      await manager.update(User, profile.userId, { avatarFileId: null });
      await this.retireAvatar(manager, before);
      await this.auditService.record(manager, ctx, AuditAction.PROFILE_UPDATED, {
        targetUserId: profile.userId,
        metadata: { fields: ['avatar'] },
      });
      return { avatarKey: null };
    });
  }
}
