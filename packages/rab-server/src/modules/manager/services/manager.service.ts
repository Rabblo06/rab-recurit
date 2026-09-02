import { assertTransition, ManagerType, normalizeEmail, PermissionFlag, USER_STATUS_TRANSITIONS, UserStatus } from '@rab/shared';
import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { EntityManager, In } from 'typeorm';

import { AccountInvite, Organisation, OrganisationMember, Permission, Role, RolePermission, User, UserRole } from '../../identity/entities';
import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { TenantContextService } from '../../../engine/core-modules/tenant/tenant-context.service';
import { AccountInviteService, InvitationLifecycleStatus } from '../../../engine/core-modules/auth/services/account-invite.service';
import { AccountLifecycleService } from '../../../engine/core-modules/auth/services/account-lifecycle.service';
import { AuditAction, AuditService } from '../../../engine/core-modules/audit/audit.service';
import { RefreshTokenService } from '../../../engine/core-modules/auth/token/services/refresh-token.service';
import { PlatformAdminService } from '../../../engine/core-modules/platform-admin/platform-admin.service';
import { PaginationDto, paginationSkipTake } from '../../../engine/dto/pagination.dto';
import { Venue } from '../../venue/entities/venue.entity';
import { ChangePendingEmailDto } from '../../identity/dto/change-pending-email.dto';
import { CreateManagerDto } from '../dto/create-manager.dto';
import { UpdateManagerDto } from '../dto/update-manager.dto';
import { ManagerProfile } from '../entities/manager-profile.entity';
import { ManagerVenue } from '../entities/manager-venue.entity';

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
  ) {}

  private async ensureRole(manager: EntityManager, organisationId: string, type: string): Promise<Role> {
    const def = ROLE_DEFS[type]!;
    let role = await manager.findOne(Role, { where: { organisationId, key: def.key } });
    if (role) return role;

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

  private toSummary(profile: ManagerProfile, invite?: AccountInvite | null): ManagerSummary {
    const status = profile.user!.status;
    // Deliberately NOT gated on `!invite.revokedAt`/`!invite.acceptedAt` —
    // the console needs sendNumber/expiresAt/cleanupAt for a cancelled or
    // expired invite too (e.g. "was invitation 3 of 3" gates whether
    // Re-invite is even offered). Which of pending/cancelled/expired this
    // actually is comes from `invitationStatus`, computed separately below —
    // never conflated with `accountStatus` (User.status).
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
      type: profile.type,
      jobTitle: profile.jobTitle ?? null,
      createdAt: profile.createdAt,
      accountStatus: status,
      invitationStatus: this.accountInvite.deriveInvitationStatus(status, invite ?? null),
      mustResetPassword: profile.user!.mustResetPassword,
      pendingInvite,
    };
  }

  /** Batch-fetches each profile's latest AccountInvite row in one query — avoids an N+1 across `list()`. */
  private async toSummaries(manager: EntityManager, profiles: ManagerProfile[]): Promise<ManagerSummary[]> {
    const userIds = profiles.map((p) => p.userId);
    const invites = userIds.length
      ? await manager.find(AccountInvite, { where: { userId: In(userIds) }, order: { createdAt: 'DESC' } })
      : [];
    const latestByUser = new Map<string, AccountInvite>();
    for (const invite of invites) {
      if (!latestByUser.has(invite.userId)) latestByUser.set(invite.userId, invite);
    }
    return profiles.map((p) => this.toSummary(p, latestByUser.get(p.userId) ?? null));
  }

  /** Single-record equivalent of `toSummaries` — every non-list method (`update`, `setActive`) uses this, never the bare `toSummary(profile)`, so a pending account's badge/attempt-count/actions are correct everywhere the frontend reads them, not just in the list view. */
  private async toSummaryWithInvite(manager: EntityManager, profile: ManagerProfile): Promise<ManagerSummary> {
    const invite = await this.accountInvite.getLatest(manager, profile.userId);
    return this.toSummary(profile, invite);
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

  async list(ctx: AuthContext, pagination: PaginationDto = {}): Promise<ManagerSummary[]> {
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const profiles = await manager.find(ManagerProfile, {
        where: { organisationId: ctx.organisationId! },
        relations: { user: true },
        order: { createdAt: 'DESC' },
        ...paginationSkipTake(pagination),
      });
      return this.toSummaries(manager, profiles);
    });
  }

  /**
   * Creates a Manager in the PENDING (INVITED) state — no password is
   * generated or accepted here. `AccountInviteService.issue()` (via
   * `sendAccountInvite`) creates the one-time activation token; the account
   * sets its own password at `/auth/activate-account` and becomes ACTIVE
   * there. See `activateAccount()` on `AuthService`.
   */
  async create(ctx: AuthContext, dto: CreateManagerDto): Promise<ManagerSummary & { invite: { sendNumber: number; expiresAt: Date; delivered: boolean } }> {
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

      await this.auditService.record(manager, ctx, AuditAction.USER_CREATED, { targetUserId: userId });
      const invite = await this.accountLifecycle.sendAccountInvite(manager, ctx, {
        userId,
        email,
        createdBy: ctx.userId,
      });

      if (dto.type === ManagerType.CEO) {
        await this.auditService.record(manager, ctx, AuditAction.CEO_CREATED, {
          entityType: 'user',
          entityId: userId,
        });
      }

      return {
        ...this.toSummary(profile),
        // Only a delivered send actually persisted an invite row — a failed
        // send leaves nothing committed (see AccountInviteService.prepare/
        // commit), so showing a pendingInvite here would claim an active
        // link exists when it doesn't.
        pendingInvite: invite.delivered
          ? { sendNumber: invite.sendNumber, maxSendAttempts: MAX_SEND_ATTEMPTS, expiresAt: invite.expiresAt, cleanupAt: null }
          : null,
        invitationStatus: invite.delivered ? 'pending' : null,
        invite: { sendNumber: invite.sendNumber, expiresAt: invite.expiresAt, delivered: invite.delivered },
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
  async resendInvite(ctx: AuthContext, id: string): Promise<{ sendNumber: number; expiresAt: Date; delivered: boolean }> {
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
  async changePendingEmail(ctx: AuthContext, id: string, dto: ChangePendingEmailDto): Promise<{ sendNumber: number; expiresAt: Date; delivered: boolean }> {
    const newEmail = normalizeEmail(dto.email);
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const profile = await this.findPendingProfileOrFail(manager, ctx, id);
      if (newEmail === profile.user!.email) {
        throw new BadRequestException('This is already the pending email for this account.');
      }
      const existingEmail = await manager.findOne(User, { where: { organisationId: ctx.organisationId!, email: newEmail } });
      if (existingEmail) throw new ConflictException('A user with this email already exists.');

      await this.accountInvite.revokeActive(manager, profile.userId);
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
   */
  async cancelInvite(ctx: AuthContext, id: string): Promise<void> {
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const profile = await this.findPendingProfileOrFail(manager, ctx, id);
      await this.accountInvite.revokeActive(manager, profile.userId);
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
}
