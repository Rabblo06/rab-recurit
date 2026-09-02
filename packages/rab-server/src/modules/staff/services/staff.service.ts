import {
  assertTransition,
  EMPLOYMENT_STATUS_TRANSITIONS,
  EmploymentStatus,
  normalizeEmail,
  PermissionFlag,
  USER_STATUS_TRANSITIONS,
  UserStatus,
} from '@rab/shared';
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { EntityManager, In } from 'typeorm';

import { AccountInvite, Organisation, OrganisationMember, Permission, Role, RolePermission, User, UserRole } from '../../identity/entities';
import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { TenantContextService } from '../../../engine/core-modules/tenant/tenant-context.service';
import { AccountInviteService } from '../../../engine/core-modules/auth/services/account-invite.service';
import { AccountLifecycleService } from '../../../engine/core-modules/auth/services/account-lifecycle.service';
import { AuditAction, AuditService } from '../../../engine/core-modules/audit/audit.service';
import { RefreshTokenService } from '../../../engine/core-modules/auth/token/services/refresh-token.service';
import { ResourceScopeService } from '../../../engine/core-modules/resource-scope/resource-scope.service';
import { PaginationDto, paginationSkipTake } from '../../../engine/dto/pagination.dto';
import { ChangePendingEmailDto } from '../../identity/dto/change-pending-email.dto';
import { CreateStaffDto } from '../dto/create-staff.dto';
import { UpdateStaffDto } from '../dto/update-staff.dto';
import { StaffProfile } from '../entities/staff-profile.entity';

const STAFF_ROLE_KEY = 'staff';
const STAFF_ROLE_PERMISSIONS = [PermissionFlag.OFFER_RESPOND, PermissionFlag.PAYSLIP_VIEW_OWN, PermissionFlag.ATTENDANCE_CLOCK];
const MAX_SEND_ATTEMPTS = 3;

export interface PendingInviteSummary {
  sendNumber: number;
  maxSendAttempts: number;
  expiresAt: Date;
  cleanupAt: Date | null;
}

export interface StaffSummary {
  id: string;
  staffRef: string;
  email: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  employmentStatus: string;
  startDate: string | null;
  defaultPayRatePence: number;
  createdAt: Date;
  accountStatus: string;
  mustResetPassword: boolean;
  pendingInvite: PendingInviteSummary | null;
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

  private toSummary(profile: StaffProfile, invite?: AccountInvite | null): StaffSummary {
    const status = profile.user!.status;
    const pendingInvite =
      invite && (status === UserStatus.INVITED || status === UserStatus.INVITE_EXPIRED) && !invite.acceptedAt && !invite.revokedAt
        ? { sendNumber: invite.sendNumber, maxSendAttempts: MAX_SEND_ATTEMPTS, expiresAt: invite.expiresAt, cleanupAt: invite.cleanupAt ?? null }
        : null;
    return {
      id: profile.id,
      staffRef: profile.staffRef,
      email: profile.user!.email,
      firstName: profile.user!.firstName,
      lastName: profile.user!.lastName,
      phone: profile.user!.phone ?? null,
      employmentStatus: profile.employmentStatus,
      startDate: profile.startDate ?? null,
      defaultPayRatePence: profile.defaultPayRatePence,
      createdAt: profile.createdAt,
      accountStatus: status,
      mustResetPassword: profile.user!.mustResetPassword,
      pendingInvite,
    };
  }

  /** Batch-fetches each profile's latest AccountInvite row in one query — avoids an N+1 across `list()`. */
  private async toSummaries(manager: EntityManager, profiles: StaffProfile[]): Promise<StaffSummary[]> {
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

  /** Single-record equivalent of `toSummaries` — every non-list method (`get`, `update`, `deactivate`/`reactivate`) uses this, never the bare `toSummary(profile)`, so a pending account's badge/attempt-count/actions are correct everywhere the frontend reads them, not just in the list view. */
  private async toSummaryWithInvite(manager: EntityManager, profile: StaffProfile): Promise<StaffSummary> {
    const invite = await this.accountInvite.getLatest(manager, profile.userId);
    return this.toSummary(profile, invite);
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

  async list(ctx: AuthContext, pagination: PaginationDto = {}): Promise<StaffSummary[]> {
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const profiles = await manager.find(StaffProfile, {
        where: { organisationId: ctx.organisationId!, createdBy: ctx.userId },
        relations: { user: true },
        order: { createdAt: 'DESC' },
        ...paginationSkipTake(pagination),
      });
      return this.toSummaries(manager, profiles);
    });
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
  async create(ctx: AuthContext, dto: CreateStaffDto): Promise<StaffSummary & { invite: { sendNumber: number; expiresAt: Date; delivered: boolean } }> {
    this.resourceScope.assertHasWorkspace(ctx);
    const email = normalizeEmail(dto.email);

    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const existingRef = await manager.findOne(StaffProfile, {
        where: { organisationId: ctx.organisationId!, staffRef: dto.staffRef },
      });
      if (existingRef) throw new ConflictException('A staff member with this reference already exists.');

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
        staffRef: dto.staffRef,
        startDate: dto.startDate,
        defaultPayRatePence: dto.defaultPayRatePence ?? 0,
        employmentStatus: EmploymentStatus.ACTIVE,
        createdBy: ctx.userId,
      });
      const profile = await manager.findOneByOrFail(StaffProfile, {
        id: profileResult.identifiers[0]!.id as string,
      });
      profile.user = await manager.findOneByOrFail(User, { id: userId });

      await this.auditService.record(manager, ctx, AuditAction.USER_CREATED, { targetUserId: userId });
      const invite = await this.accountLifecycle.sendAccountInvite(manager, ctx, { userId, email, createdBy: ctx.userId });

      return {
        ...this.toSummary(profile),
        // Only a delivered send actually persisted an invite row — a failed
        // send leaves nothing committed (see AccountInviteService.prepare/
        // commit), so showing a pendingInvite here would claim an active
        // link exists when it doesn't.
        pendingInvite: invite.delivered
          ? { sendNumber: invite.sendNumber, maxSendAttempts: MAX_SEND_ATTEMPTS, expiresAt: invite.expiresAt, cleanupAt: null }
          : null,
        invite: { sendNumber: invite.sendNumber, expiresAt: invite.expiresAt, delivered: invite.delivered },
      };
    });
  }

  async update(ctx: AuthContext, id: string, dto: UpdateStaffDto): Promise<StaffSummary> {
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const profile = await manager.findOne(StaffProfile, { where: { id }, relations: { user: true } });
      if (!profile) throw new NotFoundException('Staff member not found.');
      this.assertOwned(ctx, profile);

      const { firstName, lastName, phone, ...profileFields } = dto;
      if (firstName !== undefined || lastName !== undefined || phone !== undefined) {
        await manager.update(User, profile.userId, {
          ...(firstName !== undefined && { firstName }),
          ...(lastName !== undefined && { lastName }),
          ...(phone !== undefined && { phone }),
        });
      }
      if (Object.keys(profileFields).length > 0) {
        await manager.update(StaffProfile, id, profileFields);
      }

      const refreshed = await manager.findOneByOrFail(StaffProfile, { id });
      refreshed.user = await manager.findOneByOrFail(User, { id: profile.userId });
      return this.toSummaryWithInvite(manager, refreshed);
    });
  }

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
      } else if (status === EmploymentStatus.ACTIVE && profile.user!.status === UserStatus.SUSPENDED) {
        await manager.update(User, profile.userId, { status: UserStatus.ACTIVE });
        profile.user!.status = UserStatus.ACTIVE;
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

  /** Corrects a wrong pending email before activation — see `ManagerService.changePendingEmail`'s own doc comment for the count-reset trade-off (identical decision, mirrored here). */
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

  /** Revokes any active token and marks the account DEACTIVATED — see `ManagerService.cancelInvite`'s own doc comment (identical decision, mirrored here). */
  async cancelInvite(ctx: AuthContext, id: string): Promise<void> {
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const profile = await this.findPendingProfileOrFail(manager, ctx, id);
      await this.accountInvite.revokeActive(manager, profile.userId);
      assertTransition(USER_STATUS_TRANSITIONS, profile.user!.status, UserStatus.DEACTIVATED);
      await manager.update(User, profile.userId, { status: UserStatus.DEACTIVATED });
      await this.auditService.record(manager, ctx, AuditAction.INVITE_CANCELLED, { targetUserId: profile.userId });
    });
  }
}
