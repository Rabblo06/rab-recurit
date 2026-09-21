import { assertTransition, EmailOutboxJobType, EmailOutboxStatusType, ManagerType, normalizeEmail, PermissionFlag, USER_STATUS_TRANSITIONS, UserStatus } from '@rab/shared';
import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { EntityManager, In } from 'typeorm';

import { AccountInvite, EmailOutbox, Organisation, OrganisationMember, Permission, Role, RolePermission, User, UserRole } from '../../identity/entities';
import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { TenantContextService } from '../../../engine/core-modules/tenant/tenant-context.service';
import { AccountInviteService, InvitationLifecycleStatus } from '../../../engine/core-modules/auth/services/account-invite.service';
import { AccountLifecycleService } from '../../../engine/core-modules/auth/services/account-lifecycle.service';
import { AuditAction, AuditService } from '../../../engine/core-modules/audit/audit.service';
import { EmailOutboxService } from '../../../engine/core-modules/email/email-outbox.service';
import { EmailQueueService } from '../../../engine/core-modules/email/email-queue.service';
import { RefreshTokenService } from '../../../engine/core-modules/auth/token/services/refresh-token.service';
import { PlatformAdminService } from '../../../engine/core-modules/platform-admin/platform-admin.service';
import { UserDeletionService } from '../../../engine/core-modules/user-deletion/user-deletion.service';
import { PaginationDto, paginationSkipTake } from '../../../engine/dto/pagination.dto';
import { toIlikePattern } from '../../../engine/utils/ilike-pattern.util';
import { Venue } from '../../venue/entities/venue.entity';
import { BulkEmailDto } from '../../staff/dto/bulk-email.dto';
import { AddNoteDto } from '../../identity/dto/add-note.dto';
import { ChangePendingEmailDto } from '../../identity/dto/change-pending-email.dto';
import { UserNoteItem, UserNoteService } from '../../identity/services/user-note.service';
import { AuditLogListItem } from '../../../engine/core-modules/audit/audit.service';
import { CreateManagerDto } from '../dto/create-manager.dto';
import { ListManagersDto } from '../dto/list-managers.dto';
import { UpdateManagerDto } from '../dto/update-manager.dto';
import { ManagerProfile } from '../entities/manager-profile.entity';
import { ManagerVenue } from '../entities/manager-venue.entity';

/** Same allowlist-via-lookup-map pattern as `StaffService`'s `STAFF_SORT_COLUMNS` — see that file's comment. */
const MANAGER_SORT_COLUMNS: Record<string, string> = {
  name: 'user.firstName',
  email: 'user.email',
  accountStatus: 'user.status',
  jobTitle: 'mp.jobTitle',
  createdAt: 'mp.createdAt',
};

const ROLE_DEFS: Record<string, { key: string; name: string; permissions: string[] }> = {
  [ManagerType.INTERNAL]: {
    key: 'manager',
    name: 'Manager',
    permissions: [
      PermissionFlag.STAFF_VIEW,
      PermissionFlag.STAFF_CREATE,
      PermissionFlag.STAFF_EDIT,
      PermissionFlag.STAFF_DEACTIVATE,
      PermissionFlag.STAFF_VIEW_SENSITIVE,
      PermissionFlag.USER_RESET_PASSWORD,
      PermissionFlag.VENUE_VIEW,
      PermissionFlag.VENUE_CREATE,
      PermissionFlag.VENUE_EDIT,
      PermissionFlag.SCHEDULE_VIEW,
      PermissionFlag.SCHEDULE_CREATE,
      PermissionFlag.SCHEDULE_PUBLISH,
      PermissionFlag.SCHEDULE_BULK,
      PermissionFlag.SCHEDULE_OVERRIDE_CONFLICT,
      PermissionFlag.OFFER_SEND,
      PermissionFlag.OFFER_WITHDRAW,
      PermissionFlag.OFFER_CONFIRM,
      PermissionFlag.ATTENDANCE_VIEW,
      PermissionFlag.ATTENDANCE_EDIT,
      PermissionFlag.ATTENDANCE_APPROVE,
      PermissionFlag.ATTENDANCE_CLOCK_OVERRIDE,
      PermissionFlag.PAYROLL_VIEW,
      PermissionFlag.PAYROLL_CALCULATE,
      PermissionFlag.PAYSLIP_VIEW_ALL,
      PermissionFlag.REVIEW_CREATE,
      PermissionFlag.STAFFING_REQUEST_CREATE,
      PermissionFlag.STAFFING_REQUEST_APPROVE,
      PermissionFlag.REPORT_VIEW,
      PermissionFlag.REPORT_EXPORT,
      PermissionFlag.AUDIT_VIEW,
    ],
  },
  [ManagerType.VENUE]: {
    key: 'venue_manager',
    name: 'Venue Manager',
    permissions: [
      PermissionFlag.STAFF_VIEW,
      PermissionFlag.VENUE_VIEW,
      PermissionFlag.SCHEDULE_VIEW,
      PermissionFlag.ATTENDANCE_VIEW,
      PermissionFlag.REVIEW_CREATE,
      PermissionFlag.STAFFING_REQUEST_CREATE,
      PermissionFlag.REPORT_VIEW,
    ],
  },
  /**
   * Everything `manager` (Internal) already has, plus `MANAGER_MANAGE` — the
   * one thing a Manager structurally cannot do (create/manage Manager and
   * Venue Manager accounts). No principled reason to give CEO less
   * operational power than a Manager while giving them structurally more.
   * Deliberately withheld: ROLE_MANAGE, SETTINGS_EDIT/VIEW,
   * USER_MANAGE_PERMISSIONS, PAYROLL_APPROVE/MARK_PAID, DASHBOARD_VIEW —
   * none of these are on `manager` either.
   */
  [ManagerType.CEO]: {
    key: 'ceo',
    name: 'CEO',
    permissions: [
      PermissionFlag.STAFF_VIEW,
      PermissionFlag.STAFF_CREATE,
      PermissionFlag.STAFF_EDIT,
      PermissionFlag.STAFF_DEACTIVATE,
      PermissionFlag.STAFF_VIEW_SENSITIVE,
      PermissionFlag.USER_RESET_PASSWORD,
      PermissionFlag.MANAGER_MANAGE,
      PermissionFlag.VENUE_VIEW,
      PermissionFlag.VENUE_CREATE,
      PermissionFlag.VENUE_EDIT,
      PermissionFlag.SCHEDULE_VIEW,
      PermissionFlag.SCHEDULE_CREATE,
      PermissionFlag.SCHEDULE_PUBLISH,
      PermissionFlag.SCHEDULE_BULK,
      PermissionFlag.SCHEDULE_OVERRIDE_CONFLICT,
      PermissionFlag.OFFER_SEND,
      PermissionFlag.OFFER_WITHDRAW,
      PermissionFlag.OFFER_CONFIRM,
      PermissionFlag.ATTENDANCE_VIEW,
      PermissionFlag.ATTENDANCE_EDIT,
      PermissionFlag.ATTENDANCE_APPROVE,
      PermissionFlag.ATTENDANCE_CLOCK_OVERRIDE,
      PermissionFlag.PAYROLL_VIEW,
      PermissionFlag.PAYROLL_CALCULATE,
      PermissionFlag.PAYSLIP_VIEW_ALL,
      PermissionFlag.REVIEW_CREATE,
      PermissionFlag.STAFFING_REQUEST_CREATE,
      PermissionFlag.STAFFING_REQUEST_APPROVE,
      PermissionFlag.REPORT_VIEW,
      PermissionFlag.REPORT_EXPORT,
      PermissionFlag.AUDIT_VIEW,
    ],
  },
};

export interface PendingInviteSummary {
  sendNumber: number;
  maxSendAttempts: number;
  expiresAt: Date;
  cleanupAt: Date | null;
}

export interface ManagerSummary {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  avatarKey: string | null;
  type: string;
  jobTitle: string | null;
  createdAt: Date;
  accountStatus: string;
  invitationStatus: InvitationLifecycleStatus | null;
  mustResetPassword: boolean;
  pendingInvite: PendingInviteSummary | null;
}

const MAX_SEND_ATTEMPTS = 3;

@Injectable()
export class ManagerService {
  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly accountLifecycle: AccountLifecycleService,
    private readonly accountInvite: AccountInviteService,
    private readonly platformAdmin: PlatformAdminService,
    private readonly auditService: AuditService,
    private readonly refreshTokenService: RefreshTokenService,
    private readonly userDeletion: UserDeletionService,
    private readonly emailOutbox: EmailOutboxService,
    private readonly emailQueue: EmailQueueService,
    private readonly userNote: UserNoteService,
  ) {}

  private async ensureRole(manager: EntityManager, organisationId: string, type: string): Promise<Role> {
    const def = ROLE_DEFS[type]!;
    let role = await manager.findOne(Role, { where: { organisationId, key: def.key } });
    if (role) {
      if (type === ManagerType.VENUE && role.isSystem) {
        const defaults = await manager.createQueryBuilder(Permission, 'p').where('p.key IN (:...keys)', { keys: def.permissions }).getMany();
        if (defaults.length) await manager.createQueryBuilder().insert().into(RolePermission).values(defaults.map(permission => ({ organisationId, roleId: role!.id, permissionId: permission.id }))).orIgnore().execute();
      }
      return role;
    }

    const result = await manager.insert(Role, {
      organisationId,
      key: def.key,
      name: def.name,
      isSystem: true,
    });
    role = await manager.findOneByOrFail(Role, { id: result.identifiers[0]!.id as string });

    const permissions = await manager
      .createQueryBuilder(Permission, 'p')
      .where('p.key IN (:...keys)', { keys: def.permissions })
      .getMany();
    if (permissions.length > 0) {
      await manager.insert(
        RolePermission,
        permissions.map((permission) => ({ roleId: role!.id, permissionId: permission.id, organisationId })),
      );
    }
    return role;
  }

  private toSummary(profile: ManagerProfile, invite?: AccountInvite | null, outboxStatus?: EmailOutboxStatusType | null): ManagerSummary {
    const status = profile.user!.status;
    // Deliberately NOT gated on `!invite.revokedAt`/`!invite.acceptedAt` —
    // the console needs sendNumber/expiresAt/cleanupAt for a cancelled or
    // expired invite too (e.g. "was invitation 3 of 3" gates whether
    // Re-invite is even offered). Which of pending/cancelled/expired/queued/
    // sending/delivery_failed this actually is comes from `invitationStatus`,
    // computed separately below — never conflated with `accountStatus`
    // (User.status).
    const pendingInvite =
      invite && (status === UserStatus.INVITED || status === UserStatus.INVITE_EXPIRED)
        ? { sendNumber: invite.sendNumber, maxSendAttempts: MAX_SEND_ATTEMPTS, expiresAt: invite.expiresAt, cleanupAt: invite.cleanupAt ?? null }
        : null;
    return {
      id: profile.id,
      email: profile.user!.email,
      firstName: profile.user!.firstName,
      lastName: profile.user!.lastName,
      phone: profile.user!.phone ?? null,
      avatarKey: profile.user!.avatarKey ?? null,
      type: profile.type,
      jobTitle: profile.jobTitle ?? null,
      createdAt: profile.createdAt,
      accountStatus: status,
      invitationStatus: this.accountInvite.deriveInvitationStatus(status, invite ?? null, outboxStatus),
      mustResetPassword: profile.user!.mustResetPassword,
      pendingInvite,
    };
  }

  /** Batch-fetches each profile's latest AccountInvite row (plus its outbox status) in one query — avoids an N+1 across `list()`. */
  private async toSummaries(manager: EntityManager, profiles: ManagerProfile[]): Promise<ManagerSummary[]> {
    const userIds = profiles.map((p) => p.userId);
    const latestByUser = await this.accountInvite.getLatestManyWithOutboxStatus(manager, userIds);
    return profiles.map((p) => {
      const found = latestByUser.get(p.userId);
      return this.toSummary(p, found?.invite ?? null, found?.outboxStatus ?? null);
    });
  }

  /** Single-record equivalent of `toSummaries` — every non-list method (`update`, `setActive`) uses this, never the bare `toSummary(profile)`, so a pending account's badge/attempt-count/actions are correct everywhere the frontend reads them, not just in the list view. */
  private async toSummaryWithInvite(manager: EntityManager, profile: ManagerProfile): Promise<ManagerSummary> {
    const { invite, outboxStatus } = await this.accountInvite.getLatestWithOutboxStatus(manager, profile.userId);
    return this.toSummary(profile, invite, outboxStatus);
  }

  /**
   * CEO accounts are meant to be small, rare, and powerful — mutating one
   * (edit/deactivate/reset-password), not just creating one, requires the
   * platform-admin claim, the same protection level as creation. Any other
   * `MANAGER_MANAGE` holder — including another CEO — is blocked.
   */
  private async assertCeoMutationAllowed(manager: EntityManager, ctx: AuthContext, profile: ManagerProfile): Promise<void> {
    if (profile.type !== ManagerType.CEO) return;
    if (await this.platformAdmin.isPlatformAdminTx(manager, ctx)) return;
    throw new ForbiddenException('Only the platform administrator can manage a CEO account.');
  }

  /**
   * No ownership check — matches `list()`'s own org-wide (not per-Manager-
   * private) visibility for Manager/CEO profiles. Previously missing
   * entirely (no route called it); added so the Users page detail panel —
   * needed for a pending Manager's Resend/Change-email/Cancel actions —
   * has something to fetch, mirroring `StaffService.get()` exactly.
   */
  async get(ctx: AuthContext, id: string): Promise<ManagerSummary> {
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const profile = await manager.findOne(ManagerProfile, { where: { id, organisationId: ctx.organisationId! }, relations: { user: true } });
      if (!profile) throw new NotFoundException('Manager not found.');
      return this.toSummaryWithInvite(manager, profile);
    });
  }

  async list(ctx: AuthContext, dto: ListManagersDto = {}): Promise<{ data: ManagerSummary[]; total: number }> {
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const qb = manager
        .createQueryBuilder(ManagerProfile, 'mp')
        .leftJoinAndSelect('mp.user', 'user')
        .where('mp.organisationId = :orgId', { orgId: ctx.organisationId! });

      if (dto.q) {
        qb.andWhere('(user.firstName ILIKE :q OR user.lastName ILIKE :q OR user.email ILIKE :q)', { q: toIlikePattern(dto.q) });
      }
      if (dto.status) qb.andWhere('user.status = :status', { status: dto.status });
      if (dto.type) qb.andWhere('mp.type = :type', { type: dto.type });
      if (dto.createdAtFrom) qb.andWhere('mp.createdAt >= :createdAtFrom', { createdAtFrom: dto.createdAtFrom });
      if (dto.createdAtTo) {
        const exclusive = new Date(dto.createdAtTo);
        exclusive.setUTCDate(exclusive.getUTCDate() + 1);
        qb.andWhere('mp.createdAt < :createdAtToExclusive', { createdAtToExclusive: exclusive.toISOString() });
      }

      const sortColumn = MANAGER_SORT_COLUMNS[dto.sort ?? 'createdAt'] ?? MANAGER_SORT_COLUMNS.createdAt;
      qb.orderBy(sortColumn, (dto.direction ?? 'desc').toUpperCase() as 'ASC' | 'DESC');

      const { skip, take } = paginationSkipTake(dto);
      qb.skip(skip).take(take);

      const [profiles, total] = await qb.getManyAndCount();
      const data = await this.toSummaries(manager, profiles);
      return { data, total };
    });
  }

  /**
   * Managers are org-wide visible (matches `list()`'s own scoping — no
   * per-Manager private ownership for the Manager roster itself), so the
   * authorization re-derivation here is simpler than Staff's: any id in
   * `dto.userIds` that resolves to a real `ManagerProfile` in the caller's
   * own organisation is included, anything else silently dropped. Same
   * durable-outbox path as every other email in this app — see
   * `StaffService.bulkEmail`'s own doc comment for the full rationale.
   */
  async bulkEmail(ctx: AuthContext, dto: BulkEmailDto): Promise<{ queued: number; skipped: number }> {
    const rows = await this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const profiles = await manager.find(ManagerProfile, {
        where: { organisationId: ctx.organisationId!, id: In(dto.userIds) },
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

  /**
   * Creates a Manager in the PENDING (INVITED) state — no password is
   * generated or accepted here. `AccountInviteService.issue()` (via
   * `sendAccountInvite`) creates the one-time activation token; the account
   * sets its own password at `/auth/activate-account` and becomes ACTIVE
   * there. See `activateAccount()` on `AuthService`.
   */
  async create(ctx: AuthContext, dto: CreateManagerDto): Promise<ManagerSummary & { invite: { sendNumber: number; expiresAt: Date; queued: boolean } | null; emailQueued: boolean }> {
    const email = normalizeEmail(dto.email);

    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      // Defense-in-depth alongside CeoCreationGuard (route-level) — protects
      // any future non-HTTP caller of this method too.
      if (dto.type === ManagerType.CEO && !(await this.platformAdmin.isPlatformAdminTx(manager, ctx))) {
        throw new ForbiddenException('Only the platform administrator can create a CEO account.');
      }

      const existingEmail = await manager.findOne(User, {
        where: { organisationId: ctx.organisationId!, email },
      });
      if (existingEmail) throw new ConflictException('A user with this email already exists.');

      const userResult = await manager.insert(User, {
        organisationId: ctx.organisationId!,
        email,
        firstName: dto.firstName,
        lastName: dto.lastName,
        phone: dto.phone,
        // status omitted — the column's own DEFAULT is UserStatus.INVITED,
        // exactly the pending state this flow needs. mustResetPassword
        // defaults to false: there is no password yet to force a reset of.
      });
      const userId = userResult.identifiers[0]!.id as string;

      const role = await this.ensureRole(manager, ctx.organisationId!, dto.type);
      await manager.insert(UserRole, { userId, roleId: role.id, organisationId: ctx.organisationId! });
      // Increment 1 of the User/membership decoupling (see
      // organisation-member.entity.ts) — not read anywhere yet, just kept
      // complete going forward so a later cutover has no backfill gap.
      await manager.insert(OrganisationMember, { organisationId: ctx.organisationId!, userId });

      // A new `venue`-type profile is being assigned INTO the creating
      // Manager's own workspace (Revision 3 §10) — stamped immediately. A
      // new `internal` Manager onboards their own, separate workspace
      // later (ManagerWorkspaceService.create stamps it then); `ceo` has
      // no workspace concept at creation. Neither gets guessed here.
      const profileResult = await manager.insert(ManagerProfile, {
        organisationId: ctx.organisationId!,
        userId,
        type: dto.type,
        jobTitle: dto.jobTitle,
        workspaceId: dto.type === ManagerType.VENUE ? (ctx.workspaceId ?? undefined) : undefined,
      });
      const profile = await manager.findOneByOrFail(ManagerProfile, {
        id: profileResult.identifiers[0]!.id as string,
      });
      profile.user = await manager.findOneByOrFail(User, { id: userId });

      // Account creation must never depend on, or fail because of, email
      // deliverability — see StaffService.create()'s identical comment for
      // the full reasoning. Skipping cleanly here means no AccountInvite/
      // EmailOutbox row is ever created that could fire stale once the
      // worker comes back online.
      const emailAvailable = await this.accountLifecycle.isEmailDeliveryAvailable();
      const invite = emailAvailable
        ? await this.accountLifecycle.sendAccountInvite(manager, ctx, { userId, email, createdBy: ctx.userId })
        : null;
      await this.auditService.record(manager, ctx, AuditAction.USER_CREATED, {
        targetUserId: userId,
        metadata: { emailQueued: emailAvailable },
      });

      if (dto.type === ManagerType.CEO) {
        await this.auditService.record(manager, ctx, AuditAction.CEO_CREATED, {
          entityType: 'user',
          entityId: userId,
        });
      }

      return {
        ...this.toSummary(profile),
        // The invite row is now always durably committed before this
        // returns (A8) — delivery outcome is no longer known synchronously,
        // so this always reflects "queued", never a guess at delivered.
        // Null throughout when email was skipped at creation time.
        pendingInvite: invite
          ? { sendNumber: invite.sendNumber, maxSendAttempts: MAX_SEND_ATTEMPTS, expiresAt: invite.expiresAt, cleanupAt: null }
          : null,
        invitationStatus: invite ? ('queued' as const) : null,
        invite: invite ? { sendNumber: invite.sendNumber, expiresAt: invite.expiresAt, queued: invite.queued } : null,
        emailQueued: emailAvailable,
      };
    });
  }

  async update(ctx: AuthContext, id: string, dto: UpdateManagerDto): Promise<ManagerSummary> {
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const profile = await manager.findOne(ManagerProfile, { where: { id }, relations: { user: true } });
      if (!profile) throw new NotFoundException('Manager not found.');
      await this.assertCeoMutationAllowed(manager, ctx, profile);

      const { firstName, lastName, phone, jobTitle } = dto;
      if (firstName !== undefined || lastName !== undefined || phone !== undefined) {
        await manager.update(User, profile.userId, {
          ...(firstName !== undefined && { firstName }),
          ...(lastName !== undefined && { lastName }),
          ...(phone !== undefined && { phone }),
        });
      }
      if (jobTitle !== undefined) {
        await manager.update(ManagerProfile, id, { jobTitle });
      }

      const refreshed = await manager.findOneByOrFail(ManagerProfile, { id });
      refreshed.user = await manager.findOneByOrFail(User, { id: profile.userId });
      return this.toSummaryWithInvite(manager, refreshed);
    });
  }

  /**
   * Suspend/Reactivate — applies only to an already-ACTIVATED account
   * (invitation accepted, password set). `USER_STATUS_TRANSITIONS` alone
   * would technically allow INVITED -> ACTIVE here too (that edge exists for
   * `AuthService.activateAccount()`'s own real invitation-acceptance path),
   * which would let this endpoint silently activate a never-accepted,
   * no-password account — the exact "activate an account merely because an
   * invitation was sent" mistake this task explicitly forbids. Guarded here,
   * same message/shape as `resetPassword`'s pre-existing identical guard.
   */
  async setActive(ctx: AuthContext, id: string, active: boolean): Promise<ManagerSummary> {
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const profile = await manager.findOne(ManagerProfile, { where: { id }, relations: { user: true } });
      if (!profile) throw new NotFoundException('Manager not found.');
      await this.assertCeoMutationAllowed(manager, ctx, profile);
      if (profile.user!.status === UserStatus.INVITED || profile.user!.status === UserStatus.INVITE_EXPIRED) {
        throw new ConflictException('This account has not been activated yet — use Resend Invitation or Re-invite instead.');
      }
      const nextStatus = active ? UserStatus.ACTIVE : UserStatus.SUSPENDED;
      assertTransition(USER_STATUS_TRANSITIONS, profile.user!.status, nextStatus);
      await manager.update(User, profile.userId, { status: nextStatus });
      profile.user!.status = nextStatus;
      // Setting status alone doesn't end an already-issued session — see
      // ActiveAccountGuard for the per-request check this pairs with.
      if (!active) await this.refreshTokenService.revokeAllForUser(manager, profile.userId);
      await this.auditService.record(manager, ctx, active ? AuditAction.ACCOUNT_REACTIVATED : AuditAction.ACCOUNT_SUSPENDED, {
        targetUserId: profile.userId,
      });
      return this.toSummaryWithInvite(manager, profile);
    });
  }

  /** Admin-triggered reset — see `StaffService.resetPassword` / `AccountLifecycleService.adminResetPassword`. */
  async resetPassword(ctx: AuthContext, id: string): Promise<void> {
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const profile = await manager.findOne(ManagerProfile, { where: { id }, relations: { user: true } });
      if (!profile) throw new NotFoundException('Manager not found.');
      await this.assertCeoMutationAllowed(manager, ctx, profile);
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

  private async findPendingProfileOrFail(manager: EntityManager, ctx: AuthContext, id: string): Promise<ManagerProfile> {
    const profile = await manager.findOne(ManagerProfile, { where: { id }, relations: { user: true } });
    if (!profile) throw new NotFoundException('Manager not found.');
    await this.assertCeoMutationAllowed(manager, ctx, profile);
    if (profile.user!.status !== UserStatus.INVITED && profile.user!.status !== UserStatus.INVITE_EXPIRED) {
      throw new ConflictException('This account is not a pending invitation.');
    }
    return profile;
  }

  /** "Resend Invitation" — issues attempt N+1 (max 3 total, see AccountInviteService), revoking whatever was active. Never confused with the Resend *email provider* — this always sends through whichever provider is currently configured. */
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

  /**
   * Corrects a wrong pending email before activation. SECURITY TRADE-OFF /
   * explicit decision: the 3-attempt count is NOT reset by this action — it
   * stays cumulative across the correction. Resetting it on every edit would
   * let an admin bypass the attempt cap by repeatedly "correcting" the
   * email; nothing else in this codebase resets an abuse-prevention counter
   * on an unrelated edit (e.g. login lockout isn't cleared by an admin
   * action either). The old email can never activate the account again —
   * every currently-active token is revoked before the email changes.
   */
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
   * Revokes the active token only — `User.status` is deliberately left as
   * INVITED. A cancelled invitation is NOT an account state (never
   * SUSPENDED/DEACTIVATED); it's a property of the `AccountInvite` row
   * itself (`revokedAt` set, `acceptedAt` never set — see
   * `AccountInviteService.deriveInvitationStatus`). Leaving `User.status`
   * untouched is what makes Re-invite "just work": it reuses `resendInvite`
   * unchanged, which already only requires `status IN (INVITED,
   * INVITE_EXPIRED)`. Never hard-deletes here either — that's the cleanup
   * job's job, under its own stricter, dependency-checked conditions.
   *
   * Previously (incorrectly) set `User.status = DEACTIVATED`, which the
   * console then rendered as "Suspended" with a live "Password: Active"
   * badge and a Reactivate button that always 409'd (DEACTIVATED has no
   * transitions out) — a cancelled invite is not a suspended account.
   *
   * ONE addition beyond the token revoke (see `StaffService.cancelInvite`'s
   * own doc comment for the full reasoning): if the account already has a
   * password set (activate-account already completed, no login yet), also
   * null it back out — `revokeActive()` alone is a no-op once a password
   * exists (its query only matches `accepted_at IS NULL`), and
   * `AuthService.login()`'s INVITED-with-a-password branch would otherwise
   * still let them in and self-activate despite this "cancel." Nulling the
   * password avoids reintroducing the exact DEACTIVATED dead-end described
   * above — status stays untouched, Re-invite keeps working unchanged.
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
   * Assigns a Venue Manager to a Venue — the data this session's audit found
   * `ManagerVenue` was defined for but never wired up. Only a `type: venue`
   * profile can be assigned (assigning a venue to an Internal Manager or
   * CEO profile is meaningless — they already see every org venue).
   */
  async assignVenue(ctx: AuthContext, managerId: string, venueId: string): Promise<void> {
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const profile = await manager.findOne(ManagerProfile, { where: { id: managerId } });
      if (!profile) throw new NotFoundException('Manager not found.');
      if (profile.type !== ManagerType.VENUE) {
        throw new BadRequestException('Only a Venue Manager profile can be assigned a venue.');
      }
      const venue = await manager.findOne(Venue, { where: { id: venueId } });
      if (!venue) throw new NotFoundException('Venue not found.');

      // workspace_id stamped from the Venue, not the target profile's own
      // (frequently still-unresolved) workspaceId — keeps ManagerVenue.
      // workspaceId = Venue.workspaceId true by construction, matching the
      // cross-boundary integrity invariant verified during backfill.
      await manager.query(
        `INSERT INTO core.manager_venue (organisation_id, manager_profile_id, venue_id, workspace_id)
         VALUES ($1, $2, $3, $4) ON CONFLICT (manager_profile_id, venue_id) DO NOTHING`,
        [ctx.organisationId, managerId, venueId, venue.workspaceId],
      );

      // Resolves the "isn't resolved at creation time yet" gap flagged on
      // `ManagerProfile.workspaceId`'s own doc comment: a `type: venue`
      // profile is born with a NULL workspace_id, which leaves
      // `core.resolve_workspace_for_user()` (and therefore `ctx.workspaceId`
      // for every one of this Venue Manager's future requests) permanently
      // NULL until something sets it — and `core.current_workspace()` being
      // NULL makes the `user_select` RLS policy's `sp.workspace_id =
      // core.current_workspace()` / `mp.workspace_id = core.current_workspace()`
      // branches never match, silently hiding EVERY other user (all staff
      // included) from this Venue Manager at the RLS layer, regardless of
      // what any service-level query asks for. First venue assignment is
      // this profile's first real link to an operating workspace, so it's
      // the natural point to resolve it — never overwritten on a later
      // assignment (a Venue Manager already resolved to one workspace stays
      // there; assigning them a second venue from a different workspace is
      // the known, still-unsolved multi-workspace case the migration plan
      // itself flags, not something to silently paper over here).
      if (!profile.workspaceId && venue.workspaceId) {
        await manager.update(ManagerProfile, managerId, { workspaceId: venue.workspaceId });
      }

      await this.auditService.record(manager, ctx, AuditAction.MANAGER_VENUE_ASSIGNED, {
        entityType: 'manager',
        entityId: managerId,
        metadata: { venueId },
      });
    });
  }

  async unassignVenue(ctx: AuthContext, managerId: string, venueId: string): Promise<void> {
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      await manager.query(`DELETE FROM core.manager_venue WHERE manager_profile_id = $1 AND venue_id = $2`, [managerId, venueId]);
      await this.auditService.record(manager, ctx, AuditAction.MANAGER_VENUE_UNASSIGNED, {
        entityType: 'manager',
        entityId: managerId,
        metadata: { venueId },
      });
    });
  }

  async listVenues(ctx: AuthContext, managerId: string): Promise<Venue[]> {
    return this.tenantContext.runInTenantContext(ctx, (manager) =>
      manager
        .createQueryBuilder(Venue, 'v')
        .innerJoin(ManagerVenue, 'mv', 'mv.venue_id = v.id')
        .where('mv.manager_profile_id = :managerId', { managerId })
        .getMany(),
    );
  }

  /** General "change email" — active or pending, one mutation either way. See `StaffService.changeEmail`'s identical doc comment. */
  /** Unified "change email" — see `StaffService.changeEmail`'s own doc comment for why this never touches the invitation token/send, even for a pending account, and the security trade-off that follows from it. */
  async changeEmail(ctx: AuthContext, id: string, dto: ChangePendingEmailDto): Promise<{ email: string }> {
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const profile = await manager.findOne(ManagerProfile, { where: { id, organisationId: ctx.organisationId! }, relations: { user: true } });
      if (!profile) throw new NotFoundException('Manager not found.');
      await this.assertCeoMutationAllowed(manager, ctx, profile);

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
      const p = await manager.findOne(ManagerProfile, { where: { id, organisationId: ctx.organisationId! } });
      if (!p) throw new NotFoundException('Manager not found.');
      return p;
    });
    return this.auditService.listForUser(ctx, profile.userId);
  }

  /** Backs the detail panel's Note tab. */
  async listNotes(ctx: AuthContext, id: string): Promise<UserNoteItem[]> {
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const profile = await manager.findOne(ManagerProfile, { where: { id, organisationId: ctx.organisationId! } });
      if (!profile) throw new NotFoundException('Manager not found.');
      return this.userNote.list(manager, ctx, profile.userId);
    });
  }

  async addNote(ctx: AuthContext, id: string, dto: AddNoteDto): Promise<UserNoteItem> {
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const profile = await manager.findOne(ManagerProfile, { where: { id, organisationId: ctx.organisationId! } });
      if (!profile) throw new NotFoundException('Manager not found.');
      return this.userNote.add(manager, ctx, profile.userId, dto.body);
    });
  }

  /** Backs the detail panel's Email tab — see StaffService.listEmails's identical doc comment. */
  async listEmails(ctx: AuthContext, id: string): Promise<Array<{ id: string; subject: string; status: string; createdAt: Date; sentAt: Date | null }>> {
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const profile = await manager.findOne(ManagerProfile, { where: { id, organisationId: ctx.organisationId! } });
      if (!profile) throw new NotFoundException('Manager not found.');
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
   * replacement (B1). Same authorization shape every other Manager
   * mutation here already uses (org-wide for a MANAGER_MANAGE holder,
   * `assertCeoMutationAllowed` for a CEO target) — deliberately NOT a new,
   * stricter creator-private rule invented just for delete, which would
   * make it behave inconsistently with Suspend/Reactivate/Reset-password
   * on the exact same entity. `UserDeletionService.assertCanDelete` is the
   * actual safety gate (self-delete, platform admin, owned workspace,
   * protected operational history).
   */
  async deleteUser(ctx: AuthContext, id: string): Promise<void> {
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const profile = await manager.findOne(ManagerProfile, { where: { id }, relations: { user: true } });
      if (!profile) throw new NotFoundException('Manager not found.');
      await this.assertCeoMutationAllowed(manager, ctx, profile);

      await this.userDeletion.assertCanDelete(manager, ctx, profile.userId);
      await this.userDeletion.deleteUser(manager, ctx, profile.userId, profile.user!.email);
    });
  }
}
