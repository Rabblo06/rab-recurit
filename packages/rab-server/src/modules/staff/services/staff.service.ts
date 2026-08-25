import {
  assertTransition,
  checkPasswordStrength,
  EMPLOYMENT_STATUS_TRANSITIONS,
  EmploymentStatus,
  generateSecurePassword,
  PermissionFlag,
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
import { CreateStaffDto } from '../dto/create-staff.dto';
import { UpdateStaffDto } from '../dto/update-staff.dto';
import { StaffProfile } from '../entities/staff-profile.entity';

const STAFF_ROLE_KEY = 'staff';
const STAFF_ROLE_PERMISSIONS = [PermissionFlag.OFFER_RESPOND, PermissionFlag.PAYSLIP_VIEW_OWN];

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
}

@Injectable()
export class StaffService {
  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly passwordHashing: PasswordHashingService,
    private readonly accountLifecycle: AccountLifecycleService,
    private readonly platformAdmin: PlatformAdminService,
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

  private toSummary(profile: StaffProfile): StaffSummary {
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
      accountStatus: profile.user!.status,
      mustResetPassword: profile.user!.mustResetPassword,
    };
  }

  /**
   * A normal manager's private scope is "Staff I created" — the platform
   * admin (see PlatformAdminService's own docstring for why that's the
   * only role exempt, not any ordinary permission) is the sole exception,
   * seeing every Staff profile in the organisation regardless of creator.
   * A profile with no creator (created before this scoping existed — see
   * ResourceOwnershipSchema1786666700000) is deliberately admin-only until
   * explicitly claimed, never guessed into a manager's scope.
   */
  private async assertOwnedOrAdmin(manager: EntityManager, ctx: AuthContext, profile: StaffProfile): Promise<void> {
    if (profile.createdBy === ctx.userId) return;
    if (await this.platformAdmin.isPlatformAdminTx(manager, ctx)) return;
    throw new NotFoundException('Staff member not found.');
  }

  async list(ctx: AuthContext, pagination: PaginationDto = {}): Promise<StaffSummary[]> {
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const isAdmin = await this.platformAdmin.isPlatformAdminTx(manager, ctx);
      const profiles = await manager.find(StaffProfile, {
        where: isAdmin ? {} : { createdBy: ctx.userId },
        relations: { user: true },
        order: { createdAt: 'DESC' },
        ...paginationSkipTake(pagination),
      });
      return profiles.map((p) => this.toSummary(p));
    });
  }

  async get(ctx: AuthContext, id: string): Promise<StaffSummary> {
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const profile = await manager.findOne(StaffProfile, { where: { id }, relations: { user: true } });
      if (!profile) throw new NotFoundException('Staff member not found.');
      await this.assertOwnedOrAdmin(manager, ctx, profile);
      return this.toSummary(profile);
    });
  }

  /**
   * The admin-visible `temporaryPassword` in the response is a manual-handoff
   * fallback (shown once, never logged, never stored beyond its hash) — the
   * primary path is the one-time setup-link email `sendInvite` fires below,
   * so the new starter never actually needs to know or use it.
   */
  async create(ctx: AuthContext, dto: CreateStaffDto): Promise<StaffSummary & { temporaryPassword: string }> {
    if (dto.temporaryPassword) {
      const check = checkPasswordStrength(dto.temporaryPassword, dto.email);
      if (!check.valid) throw new BadRequestException(check.reasons.join(' '));
    }

    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const existingRef = await manager.findOne(StaffProfile, {
        where: { organisationId: ctx.organisationId!, staffRef: dto.staffRef },
      });
      if (existingRef) throw new ConflictException('A staff member with this reference already exists.');

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

      const role = await this.ensureStaffRole(manager, ctx.organisationId!);
      await manager.insert(UserRole, { userId, roleId: role.id, organisationId: ctx.organisationId! });
      // Increment 1 of the User/membership decoupling (see
      // organisation-member.entity.ts) — not read anywhere yet, just kept
      // complete going forward so a later cutover has no backfill gap.
      await manager.insert(OrganisationMember, { organisationId: ctx.organisationId!, userId });
      // Safe to call unconditionally — a no-op once the organisation already
      // has an owner, and correct by construction if this ever races another
      // user-creation path (see PlatformAdminService).
      await this.platformAdmin.tryClaim(manager, ctx.organisationId!, userId);

      const profileResult = await manager.insert(StaffProfile, {
        organisationId: ctx.organisationId!,
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

  async update(ctx: AuthContext, id: string, dto: UpdateStaffDto): Promise<StaffSummary> {
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const profile = await manager.findOne(StaffProfile, { where: { id }, relations: { user: true } });
      if (!profile) throw new NotFoundException('Staff member not found.');
      await this.assertOwnedOrAdmin(manager, ctx, profile);

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
      return this.toSummary(refreshed);
    });
  }

  private async setEmploymentStatus(
    ctx: AuthContext,
    id: string,
    status: (typeof EmploymentStatus)[keyof typeof EmploymentStatus],
  ): Promise<StaffSummary> {
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const profile = await manager.findOne(StaffProfile, { where: { id }, relations: { user: true } });
      if (!profile) throw new NotFoundException('Staff member not found.');
      await this.assertOwnedOrAdmin(manager, ctx, profile);
      assertTransition(EMPLOYMENT_STATUS_TRANSITIONS, profile.employmentStatus, status);
      await manager.update(StaffProfile, id, { employmentStatus: status });
      profile.employmentStatus = status;
      return this.toSummary(profile);
    });
  }

  deactivate(ctx: AuthContext, id: string): Promise<StaffSummary> {
    return this.setEmploymentStatus(ctx, id, EmploymentStatus.INACTIVE);
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
      await this.assertOwnedOrAdmin(manager, ctx, profile);

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
