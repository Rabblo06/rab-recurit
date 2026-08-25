import {
  assertTransition,
  checkPasswordStrength,
  generateSecurePassword,
  ManagerType,
  PermissionFlag,
  USER_STATUS_TRANSITIONS,
  UserStatus,
} from '@rab/shared';
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import { Organisation, OrganisationMember, Permission, Role, RolePermission, User, UserRole } from '../../identity/entities';
import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { TenantContextService } from '../../../engine/core-modules/tenant/tenant-context.service';
import { AccountLifecycleService } from '../../../engine/core-modules/auth/services/account-lifecycle.service';
import { PasswordHashingService } from '../../../engine/core-modules/auth/services/password-hashing.service';
import { PlatformAdminService } from '../../../engine/core-modules/platform-admin/platform-admin.service';
import { PaginationDto, paginationSkipTake } from '../../../engine/dto/pagination.dto';
import { CreateManagerDto } from '../dto/create-manager.dto';
import { UpdateManagerDto } from '../dto/update-manager.dto';
import { ManagerProfile } from '../entities/manager-profile.entity';

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
};

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
  mustResetPassword: boolean;
}

@Injectable()
export class ManagerService {
  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly passwordHashing: PasswordHashingService,
    private readonly accountLifecycle: AccountLifecycleService,
    private readonly platformAdmin: PlatformAdminService,
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

  private toSummary(profile: ManagerProfile): ManagerSummary {
    return {
      id: profile.id,
      email: profile.user!.email,
      firstName: profile.user!.firstName,
      lastName: profile.user!.lastName,
      phone: profile.user!.phone ?? null,
      type: profile.type,
      jobTitle: profile.jobTitle ?? null,
      createdAt: profile.createdAt,
      accountStatus: profile.user!.status,
      mustResetPassword: profile.user!.mustResetPassword,
    };
  }

  async list(ctx: AuthContext, pagination: PaginationDto = {}): Promise<ManagerSummary[]> {
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const profiles = await manager.find(ManagerProfile, {
        relations: { user: true },
        order: { createdAt: 'DESC' },
        ...paginationSkipTake(pagination),
      });
      return profiles.map((p) => this.toSummary(p));
    });
  }

  async create(ctx: AuthContext, dto: CreateManagerDto): Promise<ManagerSummary & { temporaryPassword: string }> {
    if (dto.temporaryPassword) {
      const check = checkPasswordStrength(dto.temporaryPassword, dto.email);
      if (!check.valid) throw new BadRequestException(check.reasons.join(' '));
    }

    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const existingEmail = await manager.findOne(User, {
        where: { organisationId: ctx.organisationId!, email: dto.email },
      });
      if (existingEmail) throw new ConflictException('A user with this email already exists.');

      const temporaryPassword = dto.temporaryPassword ?? generateSecurePassword();
      const passwordHash = await this.passwordHashing.hash(temporaryPassword);

      const userResult = await manager.insert(User, {
        organisationId: ctx.organisationId!,
        email: dto.email,
        passwordHash,
        firstName: dto.firstName,
        lastName: dto.lastName,
        phone: dto.phone,
        status: UserStatus.ACTIVE,
        mustResetPassword: true,
      });
      const userId = userResult.identifiers[0]!.id as string;

      const role = await this.ensureRole(manager, ctx.organisationId!, dto.type);
      await manager.insert(UserRole, { userId, roleId: role.id, organisationId: ctx.organisationId! });
      // Increment 1 of the User/membership decoupling (see
      // organisation-member.entity.ts) — not read anywhere yet, just kept
      // complete going forward so a later cutover has no backfill gap.
      await manager.insert(OrganisationMember, { organisationId: ctx.organisationId!, userId });
      // Safe to call unconditionally — a no-op once the organisation already
      // has an owner, and correct by construction if this ever races another
      // user-creation path (see PlatformAdminService).
      await this.platformAdmin.tryClaim(manager, ctx.organisationId!, userId);

      const profileResult = await manager.insert(ManagerProfile, {
        organisationId: ctx.organisationId!,
        userId,
        type: dto.type,
        jobTitle: dto.jobTitle,
      });
      const profile = await manager.findOneByOrFail(ManagerProfile, {
        id: profileResult.identifiers[0]!.id as string,
      });
      profile.user = await manager.findOneByOrFail(User, { id: userId });

      const organisation = await manager.findOneByOrFail(Organisation, { id: ctx.organisationId! });
      await this.accountLifecycle.sendInvite(manager, ctx, {
        userId,
        email: dto.email,
        firstName: dto.firstName,
        organisationName: organisation.name,
      });

      return { ...this.toSummary(profile), temporaryPassword };
    });
  }

  async update(ctx: AuthContext, id: string, dto: UpdateManagerDto): Promise<ManagerSummary> {
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const profile = await manager.findOne(ManagerProfile, { where: { id }, relations: { user: true } });
      if (!profile) throw new NotFoundException('Manager not found.');

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
      return this.toSummary(refreshed);
    });
  }

  async setActive(ctx: AuthContext, id: string, active: boolean): Promise<ManagerSummary> {
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const profile = await manager.findOne(ManagerProfile, { where: { id }, relations: { user: true } });
      if (!profile) throw new NotFoundException('Manager not found.');
      const nextStatus = active ? UserStatus.ACTIVE : UserStatus.SUSPENDED;
      assertTransition(USER_STATUS_TRANSITIONS, profile.user!.status, nextStatus);
      await manager.update(User, profile.userId, { status: nextStatus });
      profile.user!.status = nextStatus;
      return this.toSummary(profile);
    });
  }

  /** Admin-triggered reset — see `StaffService.resetPassword` / `AccountLifecycleService.adminResetPassword`. */
  async resetPassword(ctx: AuthContext, id: string): Promise<void> {
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const profile = await manager.findOne(ManagerProfile, { where: { id }, relations: { user: true } });
      if (!profile) throw new NotFoundException('Manager not found.');

      const organisation = await manager.findOneByOrFail(Organisation, { id: ctx.organisationId! });
      await this.accountLifecycle.adminResetPassword(manager, ctx, {
        targetUserId: profile.userId,
        targetEmail: profile.user!.email,
        targetFirstName: profile.user!.firstName,
        organisationName: organisation.name,
      });
    });
  }
}
