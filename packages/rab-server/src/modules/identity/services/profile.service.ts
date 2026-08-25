import { NotificationType, NotificationTypeType } from '@rab/shared';
import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import { AuditAction, AuditService } from '../../../engine/core-modules/audit/audit.service';
import { RefreshTokenService } from '../../../engine/core-modules/auth/token/services/refresh-token.service';
import { StorageService } from '../../../engine/core-modules/storage/storage.service';
import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { TenantContextService } from '../../../engine/core-modules/tenant/tenant-context.service';
import { UpdateNotificationPreferenceDto } from '../dto/update-notification-preference.dto';
import { UpdateProfileDto } from '../dto/update-profile.dto';
import { UpdateUserPreferenceDto } from '../dto/update-user-preference.dto';
import { NotificationPreference, RefreshToken, User, UserPreference } from '../entities';

export interface ProfileResponse {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  avatarKey: string | null;
}

export interface SessionSummary {
  familyId: string;
  deviceId: string | null;
  userAgent: string | null;
  ip: string | null;
  createdAt: Date;
  lastActiveAt: Date;
  isCurrentDevice: boolean;
}

export interface PreferenceResponse {
  theme: string;
  navPreference: string;
  timezone: string | null;
  dateFormat: string;
  timeFormat: string;
  firstDayOfWeek: string;
}

export interface NotificationPreferenceResponse {
  notificationType: NotificationTypeType;
  inAppEnabled: boolean;
  emailEnabled: boolean;
}

/** modules/identity's first real service — own-user self-service operations (Profile/Experience/Account). */
@Injectable()
export class ProfileService {
  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly refreshTokenService: RefreshTokenService,
    private readonly auditService: AuditService,
    private readonly storageService: StorageService,
  ) {}

  async getProfile(ctx: AuthContext): Promise<ProfileResponse> {
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const user = await manager.findOneOrFail(User, { where: { id: ctx.userId } });
      return this.toProfileResponse(user);
    });
  }

  async updateProfile(ctx: AuthContext, dto: UpdateProfileDto): Promise<ProfileResponse> {
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      await manager.update(User, ctx.userId, {
        ...(dto.firstName !== undefined ? { firstName: dto.firstName } : {}),
        ...(dto.lastName !== undefined ? { lastName: dto.lastName } : {}),
      });
      const user = await manager.findOneOrFail(User, { where: { id: ctx.userId } });
      await this.auditService.record(manager, ctx, AuditAction.PROFILE_UPDATED, {
        targetUserId: ctx.userId,
        metadata: { fields: Object.keys(dto) },
      });
      return this.toProfileResponse(user);
    });
  }

  private toProfileResponse(user: User): ProfileResponse {
    return {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      avatarKey: user.avatarKey ?? null,
    };
  }

  async uploadAvatar(ctx: AuthContext, buffer: Buffer): Promise<ProfileResponse> {
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const before = await manager.findOneOrFail(User, { where: { id: ctx.userId } });
      const { key } = await this.storageService.uploadAvatar(ctx.organisationId!, ctx.userId, buffer);
      await manager.update(User, ctx.userId, { avatarKey: key });
      await this.storageService.deleteQuietly(before.avatarKey);
      await this.auditService.record(manager, ctx, AuditAction.PROFILE_UPDATED, {
        targetUserId: ctx.userId,
        metadata: { fields: ['avatar'] },
      });
      const user = await manager.findOneOrFail(User, { where: { id: ctx.userId } });
      return this.toProfileResponse(user);
    });
  }

  async deleteAvatar(ctx: AuthContext): Promise<ProfileResponse> {
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const before = await manager.findOneOrFail(User, { where: { id: ctx.userId } });
      await manager.query(`UPDATE core."user" SET avatar_key = NULL WHERE id = $1`, [ctx.userId]);
      await this.storageService.deleteQuietly(before.avatarKey);
      await this.auditService.record(manager, ctx, AuditAction.PROFILE_UPDATED, {
        targetUserId: ctx.userId,
        metadata: { fields: ['avatar'] },
      });
      const user = await manager.findOneOrFail(User, { where: { id: ctx.userId } });
      return this.toProfileResponse(user);
    });
  }

  async getPreferences(ctx: AuthContext): Promise<PreferenceResponse> {
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const pref = await this.ensurePreference(manager, ctx);
      return this.toPreferenceResponse(pref);
    });
  }

  async updatePreferences(ctx: AuthContext, dto: UpdateUserPreferenceDto): Promise<PreferenceResponse> {
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      await this.ensurePreference(manager, ctx);
      await manager.update(UserPreference, { userId: ctx.userId }, {
        ...(dto.theme !== undefined ? { theme: dto.theme } : {}),
        ...(dto.navPreference !== undefined ? { navPreference: dto.navPreference } : {}),
        ...(dto.timezone !== undefined ? { timezone: dto.timezone || undefined } : {}),
        ...(dto.dateFormat !== undefined ? { dateFormat: dto.dateFormat } : {}),
        ...(dto.timeFormat !== undefined ? { timeFormat: dto.timeFormat } : {}),
        ...(dto.firstDayOfWeek !== undefined ? { firstDayOfWeek: dto.firstDayOfWeek } : {}),
      });
      const pref = await manager.findOneByOrFail(UserPreference, { userId: ctx.userId });
      return this.toPreferenceResponse(pref);
    });
  }

  private async ensurePreference(manager: EntityManager, ctx: AuthContext): Promise<UserPreference> {
    let pref = await manager.findOne(UserPreference, { where: { userId: ctx.userId } });
    if (!pref) {
      await manager.insert(UserPreference, { userId: ctx.userId, organisationId: ctx.organisationId! });
      pref = await manager.findOneByOrFail(UserPreference, { userId: ctx.userId });
    }
    return pref;
  }

  private toPreferenceResponse(pref: UserPreference): PreferenceResponse {
    return {
      theme: pref.theme,
      navPreference: pref.navPreference,
      timezone: pref.timezone ?? null,
      dateFormat: pref.dateFormat,
      timeFormat: pref.timeFormat,
      firstDayOfWeek: pref.firstDayOfWeek,
    };
  }

  /** One session = one non-revoked, non-expired refresh_token family, grouped by its most recently issued row. */
  async listSessions(ctx: AuthContext): Promise<SessionSummary[]> {
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const rows = await manager
        .createQueryBuilder(RefreshToken, 'rt')
        .where('rt.user_id = :userId', { userId: ctx.userId })
        .andWhere('rt.revoked_at IS NULL')
        .andWhere('rt.expires_at > now()')
        .orderBy('rt.created_at', 'DESC')
        .getMany();

      const byFamily = new Map<string, RefreshToken>();
      for (const row of rows) {
        // rows are DESC by created_at — the first one seen per family is the most recent
        if (!byFamily.has(row.familyId)) byFamily.set(row.familyId, row);
      }

      return Array.from(byFamily.values()).map((row) => ({
        familyId: row.familyId,
        deviceId: row.deviceId ?? null,
        userAgent: row.userAgent ?? null,
        ip: row.ip ?? null,
        createdAt: row.createdAt,
        lastActiveAt: row.createdAt,
        isCurrentDevice: row.familyId === ctx.sessionId,
      }));
    });
  }

  async revokeSession(ctx: AuthContext, familyId: string): Promise<void> {
    await this.tenantContext.runInTenantContext(ctx, async (manager) => {
      // Scoped to the caller's own userId — a client can never revoke
      // another user's session through this route.
      const owns = await manager.findOne(RefreshToken, { where: { familyId, userId: ctx.userId } });
      if (!owns) throw new NotFoundException('Session not found.');
      if (familyId === ctx.sessionId) {
        throw new ForbiddenException('Log out to end your current session.');
      }
      await this.refreshTokenService.revokeFamily(manager, familyId);
    });
  }

  async listNotificationPreferences(ctx: AuthContext): Promise<NotificationPreferenceResponse[]> {
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const rows = await manager.find(NotificationPreference, { where: { userId: ctx.userId } });
      const byType = new Map(rows.map((r) => [r.notificationType, r]));
      return Object.values(NotificationType).map((type) => {
        const row = byType.get(type);
        return {
          notificationType: type,
          inAppEnabled: row?.inAppEnabled ?? true,
          emailEnabled: row?.emailEnabled ?? false,
        };
      });
    });
  }

  async updateNotificationPreference(
    ctx: AuthContext,
    dto: UpdateNotificationPreferenceDto,
  ): Promise<NotificationPreferenceResponse> {
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const existing = await manager.findOne(NotificationPreference, {
        where: { userId: ctx.userId, notificationType: dto.notificationType },
      });
      const inAppEnabled = dto.inAppEnabled ?? existing?.inAppEnabled ?? true;
      const emailEnabled = dto.emailEnabled ?? existing?.emailEnabled ?? false;

      if (existing) {
        await manager.update(
          NotificationPreference,
          { userId: ctx.userId, notificationType: dto.notificationType },
          { inAppEnabled, emailEnabled },
        );
      } else {
        await manager.insert(NotificationPreference, {
          userId: ctx.userId,
          organisationId: ctx.organisationId!,
          notificationType: dto.notificationType,
          inAppEnabled,
          emailEnabled,
        });
      }

      return { notificationType: dto.notificationType, inAppEnabled, emailEnabled };
    });
  }
}
