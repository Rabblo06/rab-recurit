import {
  assertTransition,
  checkPasswordStrength,
  EMPLOYMENT_STATUS_TRANSITIONS,
  EmailOutboxJobType,
  EmailOutboxStatusType,
  EmploymentStatus,
  normalizeEmail,
  PermissionFlag,
  UserStatus,
} from '@rab/shared';
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { EntityManager, In, QueryFailedError } from 'typeorm';

import { AccountInvite, EmailOutbox, Organisation, OrganisationMember, Permission, Role, RolePermission, User, UserRole } from '../../identity/entities';
import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { TenantContextService } from '../../../engine/core-modules/tenant/tenant-context.service';
import { AccountInviteService, InvitationLifecycleStatus } from '../../../engine/core-modules/auth/services/account-invite.service';
import { AccountLifecycleService } from '../../../engine/core-modules/auth/services/account-lifecycle.service';
import { PasswordHashingService } from '../../../engine/core-modules/auth/services/password-hashing.service';
import { AuditAction, AuditService } from '../../../engine/core-modules/audit/audit.service';
import { EmailOutboxService } from '../../../engine/core-modules/email/email-outbox.service';
import { EmailQueueService } from '../../../engine/core-modules/email/email-queue.service';
import { RefreshTokenService } from '../../../engine/core-modules/auth/token/services/refresh-token.service';
import { ResourceScopeService } from '../../../engine/core-modules/resource-scope/resource-scope.service';
import { UserDeletionService } from '../../../engine/core-modules/user-deletion/user-deletion.service';
import { PaginationDto, paginationSkipTake } from '../../../engine/dto/pagination.dto';
import { BulkEmailDto } from '../dto/bulk-email.dto';
import { AddNoteDto } from '../../identity/dto/add-note.dto';
import { ChangePendingEmailDto } from '../../identity/dto/change-pending-email.dto';
import { UserNoteItem, UserNoteService } from '../../identity/services/user-note.service';
import { AuditLogListItem } from '../../../engine/core-modules/audit/audit.service';
import { CreateStaffDto } from '../dto/create-staff.dto';
import { UpdateStaffDto } from '../dto/update-staff.dto';
import { StaffProfile } from '../entities/staff-profile.entity';
import { JobRole } from '../../scheduling/entities/job-role.entity';

const STAFF_ROLE_KEY = 'staff';
const STAFF_ROLE_PERMISSIONS = [PermissionFlag.OFFER_RESPOND, PermissionFlag.PAYSLIP_VIEW_OWN, PermissionFlag.ATTENDANCE_CLOCK];
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
  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly accountLifecycle: AccountLifecycleService,
    private readonly accountInvite: AccountInviteService,
    private readonly auditService: AuditService,
    private readonly refreshTokenService: RefreshTokenService,
    private readonly resourceScope: ResourceScopeService,
    private readonly userDeletion: UserDeletionService,
    private readonly emailOutbox: EmailOutboxService,
    private readonly emailQueue: EmailQueueService,
    private readonly userNote: UserNoteService,
    private readonly passwordHashing: PasswordHashingService,
  ) {}

  private async ensureStaffRole(manager: EntityManager, organisationId: string): Promise<Role> {
    let role = await manager.findOne(Role, { where: { organisationId, key: STAFF_ROLE_KEY } });
    if (role) return role;

    const result = await manager.insert(Role, {
      organisationId,
      key: STAFF_ROLE_KEY,
      name: 'Staff',
      isSystem: true,
    });
    role = await manager.findOneByOrFail(Role, { id: result.identifiers[0]!.id as string });

    const permissions = await manager
      .createQueryBuilder(Permission, 'p')
      .where('p.key IN (:...keys)', { keys: STAFF_ROLE_PERMISSIONS })
      .getMany();
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
      avatarKey: profile.user!.avatarKey ?? null,
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
  private async assertJobRoleAccessible(manager: EntityManager, ctx: AuthContext, jobRoleId: string): Promise<void> {
    // 404, not 400/403 — a job role outside the caller's scope is
    // indistinguishable from one that doesn't exist (CLAUDE.md, matching
    // SchedulingService.assertJobRoleOwned's identical choice for the
    // exact same entity).
    const jobRole = await manager.findOne(JobRole, { where: { id: jobRoleId, organisationId: ctx.organisationId! } });
    if (!jobRole) throw new NotFoundException('Job role not found.');
    const scope = await this.resourceScope.resolveTx(manager, ctx);
    if (scope.kind === 'venue') return;
    if (scope.kind === 'owner' && jobRole.createdBy === ctx.userId) return;
    throw new NotFoundException('Job role not found.');
  }

  async list(ctx: AuthContext, pagination: PaginationDto = {}): Promise<StaffListSummary[]> {
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const profiles = await manager.find(StaffProfile, {
        where: { organisationId: ctx.organisationId!, createdBy: ctx.userId },
        relations: { user: true },
        order: { createdAt: 'DESC' },
        ...paginationSkipTake(pagination),
      });
      const summaries = await this.toSummaries(manager, profiles);
      return summaries.map(toListSummary);
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
    const rows = await this.tenantContext.runInTenantContext(ctx, async (manager) => {
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
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const profile = await manager.findOne(StaffProfile, { where: { id }, relations: { user: true } });
      if (!profile) throw new NotFoundException('Staff member not found.');
      this.assertOwned(ctx, profile);
      return this.toSummaryWithInvite(manager, profile);
    });
  }

  /**
   * Creates a Staff member in the PENDING (INVITED) state — no password is
   * generated or accepted here. Mirrors `ManagerService.create()` exactly;
   * see its own doc comment for the activation flow.
   */
  /**
   * A UI suggestion only — never trusted as authoritative. `create()`'s own
   * case-insensitive pre-check plus its 23505-to-409 catch remain the real
   * uniqueness guarantee (a concurrent create for the suggested ref becomes
   * a clean 409, never a 500). Scoped to the caller's own private Workspace,
   * never another Manager's — matches `create()`'s own workspace gate.
   */
  async suggestNextStaffRef(ctx: AuthContext): Promise<{ staffRef: string }> {
    this.resourceScope.assertHasWorkspace(ctx);
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const rows = await manager
        .createQueryBuilder(StaffProfile, 'sp')
        .select('sp.staff_ref', 'staffRef')
        .where('sp.workspace_id = :workspaceId', { workspaceId: ctx.workspaceId })
        .getRawMany<{ staffRef: string }>();
      const highest = rows.reduce((max, row) => {
        const match = /^staff(\d+)$/i.exec(row.staffRef.trim());
        if (!match) return max;
        return Math.max(max, parseInt(match[1]!, 10));
      }, 0);
      return { staffRef: `staff${highest + 1}` };
    });
  }

  async create(ctx: AuthContext, dto: CreateStaffDto): Promise<StaffSummary & { invite: { sendNumber: number; expiresAt: Date; queued: boolean } | null; emailQueued: boolean }> {
    this.resourceScope.assertHasWorkspace(ctx);
    const email = normalizeEmail(dto.email);
    const staffRef = dto.staffRef.trim();

    try {
      return await this.tenantContext.runInTenantContext(ctx, async (manager) => {
        // Case-insensitive pre-check — "STF-001" and "stf-001" are the same
        // reference to a person reading the Users table, even though the
        // underlying column is plain `text` (case-sensitive at the DB
        // constraint level; a same-instant race between two differently-cased
        // duplicates is the one residual gap this doesn't close, disclosed
        // rather than silently claimed fixed).
        const existingRef = await manager
          .createQueryBuilder(StaffProfile, 'sp')
          .where('sp.organisation_id = :orgId', { orgId: ctx.organisationId })
          .andWhere('lower(sp.staff_ref) = lower(:staffRef)', { staffRef })
          .getOne();
        if (existingRef) throw new ConflictException('A staff member with this reference already exists.');

        const existingEmail = await manager.findOne(User, {
          where: { organisationId: ctx.organisationId!, email },
        });
        if (existingEmail) throw new ConflictException('A user with this email already exists.');

        if (dto.jobRoleId) {
          await this.assertJobRoleAccessible(manager, ctx, dto.jobRoleId);
        }

        // Optional Manager-set/generated temporary credential — hashed into
        // `temporaryPasswordHash`, never `passwordHash` itself. See that
        // column's own comment on the User entity for why the two must
        // never be the same column (it's what keeps AuthService.login()'s
        // first-login-activation check safe).
        let temporaryPasswordHash: string | undefined;
        if (dto.temporaryPassword) {
          const { valid, reasons } = checkPasswordStrength(dto.temporaryPassword, email);
          if (!valid) throw new BadRequestException(reasons.join(' '));
          temporaryPasswordHash = await this.passwordHashing.hash(dto.temporaryPassword);
        }

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
      // The pre-checks above close the common case; this is the backstop for
      // the genuine concurrent-request race (two creates for the same
      // staffRef/email landing between the pre-check and the insert) — a raw
      // Postgres unique-violation (23505) becomes a controlled 409 instead of
      // an unhandled 500.
      if (e instanceof QueryFailedError && (e as unknown as { code?: string }).code === '23505') {
        throw new ConflictException('A staff member with this reference or email already exists.');
      }
      throw e;
    }
  }

  async update(ctx: AuthContext, id: string, dto: UpdateStaffDto): Promise<StaffSummary> {
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const profile = await manager.findOne(StaffProfile, { where: { id }, relations: { user: true } });
      if (!profile) throw new NotFoundException('Staff member not found.');
      this.assertOwned(ctx, profile);

      if (dto.jobRoleId) {
        await this.assertJobRoleAccessible(manager, ctx, dto.jobRoleId);
      }

      const { firstName, lastName, phone, staffRef, ...profileFields } = dto;
      if (staffRef !== undefined) {
        const trimmed = staffRef.trim();
        const existingRef = await manager
          .createQueryBuilder(StaffProfile, 'sp')
          .where('sp.organisation_id = :orgId', { orgId: ctx.organisationId })
          .andWhere('sp.id != :id', { id })
          .andWhere('lower(sp.staff_ref) = lower(:staffRef)', { staffRef: trimmed })
          .getOne();
        if (existingRef) throw new ConflictException('A staff member with this reference already exists.');
        (profileFields as Record<string, unknown>).staffRef = trimmed;
      }
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
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const profile = await manager.findOne(StaffProfile, { where: { id }, relations: { user: true } });
      if (!profile) throw new NotFoundException('Staff member not found.');
      this.assertOwned(ctx, profile);
      if (profile.user!.status === UserStatus.INVITED || profile.user!.status === UserStatus.INVITE_EXPIRED) {
        throw new ConflictException('This account has not been activated yet — use Cancel Invitation or Resend Invitation instead.');
      }
      assertTransition(EMPLOYMENT_STATUS_TRANSITIONS, profile.employmentStatus, status);
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
        profile.user!.status = UserStatus.SUSPENDED;
        await this.refreshTokenService.revokeAllForUser(manager, profile.userId);
        await this.auditService.record(manager, ctx, AuditAction.ACCOUNT_SUSPENDED, { targetUserId: profile.userId });
      } else if (status === EmploymentStatus.ACTIVE && profile.user!.status === UserStatus.SUSPENDED) {
        await manager.update(User, profile.userId, { status: UserStatus.ACTIVE });
        profile.user!.status = UserStatus.ACTIVE;
        await this.auditService.record(manager, ctx, AuditAction.ACCOUNT_REACTIVATED, { targetUserId: profile.userId });
      }

      if (onTransitioned) await onTransitioned(manager, profile);
      return this.toSummaryWithInvite(manager, profile);
    });
  }

  deactivate(ctx: AuthContext, id: string): Promise<StaffSummary> {
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

  reactivate(ctx: AuthContext, id: string): Promise<StaffSummary> {
    return this.setEmploymentStatus(ctx, id, EmploymentStatus.ACTIVE);
  }

  /**
   * Admin-triggered reset — the admin never sees or sets the target's new
   * password, only a fresh one-time setup link goes out. See
   * `AccountLifecycleService.adminResetPassword`.
   */
  async resetPassword(ctx: AuthContext, id: string): Promise<void> {
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
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
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
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
    const newEmail = normalizeEmail(dto.email);
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
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
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
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
  async changeEmail(ctx: AuthContext, id: string, dto: ChangePendingEmailDto): Promise<{ email: string }> {
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const profile = await manager.findOne(StaffProfile, { where: { id }, relations: { user: true } });
      if (!profile) throw new NotFoundException('Staff member not found.');
      this.assertOwned(ctx, profile);

      const newEmail = normalizeEmail(dto.email);
      if (newEmail === profile.user!.email) {
        throw new BadRequestException('This is already this account\'s email.');
      }
      const existingEmail = await manager.findOne(User, { where: { organisationId: ctx.organisationId!, email: newEmail } });
      if (existingEmail) throw new ConflictException('A user with this email already exists.');

      await manager.update(User, profile.userId, { email: newEmail });
      await this.auditService.record(manager, ctx, AuditAction.PROFILE_UPDATED, {
        targetUserId: profile.userId,
        metadata: { field: 'email', from: profile.user!.email, to: newEmail },
      });
      return { email: newEmail };
    });
  }

  /** Backs the detail panel's Timeline tab. */
  async getTimeline(ctx: AuthContext, id: string): Promise<AuditLogListItem[]> {
    const profile = await this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const p = await manager.findOne(StaffProfile, { where: { id } });
      if (!p) throw new NotFoundException('Staff member not found.');
      this.assertOwned(ctx, p);
      return p;
    });
    return this.auditService.listForUser(ctx, profile.userId);
  }

  /** Backs the detail panel's Note tab. */
  async listNotes(ctx: AuthContext, id: string): Promise<UserNoteItem[]> {
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const profile = await manager.findOne(StaffProfile, { where: { id } });
      if (!profile) throw new NotFoundException('Staff member not found.');
      this.assertOwned(ctx, profile);
      return this.userNote.list(manager, ctx, profile.userId);
    });
  }

  async addNote(ctx: AuthContext, id: string, dto: AddNoteDto): Promise<UserNoteItem> {
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
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
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
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
   */
  async deleteUser(ctx: AuthContext, id: string): Promise<void> {
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const profile = await manager.findOne(StaffProfile, { where: { id }, relations: { user: true } });
      if (!profile) throw new NotFoundException('Staff member not found.');
      this.assertOwned(ctx, profile);

      await this.userDeletion.assertCanDelete(manager, ctx, profile.userId);
      await this.userDeletion.deleteUser(manager, ctx, profile.userId, profile.user!.email);
    });
  }
}
