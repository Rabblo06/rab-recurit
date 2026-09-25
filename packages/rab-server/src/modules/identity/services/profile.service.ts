import { NotificationType, NotificationTypeType } from '@rab/shared';
import { ForbiddenException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import { ManagerProfile } from '../../manager/entities/manager-profile.entity';
import { AuditAction, AuditService } from '../../../engine/core-modules/audit/audit.service';
import { ABSOLUTE_SESSION_TTL_MS, RefreshTokenService } from '../../../engine/core-modules/auth/token/services/refresh-token.service';
import { FileAccessRegistry } from '../../../engine/core-modules/storage/file-access.registry';
import { FileKind } from '../../../engine/core-modules/storage/file-kinds';
import { FileService } from '../../../engine/core-modules/storage/file.service';
import { StoredFile } from '../../../engine/core-modules/storage/entities/stored-file.entity';
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
  jobTitle: string | null;
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
export class ProfileService implements OnModuleInit {
  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly refreshTokenService: RefreshTokenService,
    private readonly auditService: AuditService,
    private readonly fileService: FileService,
    private readonly fileRegistry: FileAccessRegistry,
  ) {}

  async getProfile(ctx: AuthContext): Promise<ProfileResponse> {
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const user = await manager.findOneOrFail(User, { where: { id: ctx.userId } });
      const jobTitle = await this.getJobTitle(manager, ctx.userId);
      return this.toProfileResponse(user, jobTitle);
    });
  }

  async updateProfile(ctx: AuthContext, dto: UpdateProfileDto): Promise<ProfileResponse> {
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      await manager.update(User, ctx.userId, {
        ...(dto.firstName !== undefined ? { firstName: dto.firstName } : {}),
        ...(dto.lastName !== undefined ? { lastName: dto.lastName } : {}),
      });
      // Staff callers have no ManagerProfile row — jobTitle is silently a
      // no-op for them, same "not every caller has one" shape as every
      // other Manager-only field in this codebase.
      if (dto.jobTitle !== undefined) {
        await manager.update(ManagerProfile, { userId: ctx.userId }, { jobTitle: dto.jobTitle });
      }
      const user = await manager.findOneOrFail(User, { where: { id: ctx.userId } });
      const jobTitle = await this.getJobTitle(manager, ctx.userId);
      await this.auditService.record(manager, ctx, AuditAction.PROFILE_UPDATED, {
        targetUserId: ctx.userId,
        metadata: { fields: Object.keys(dto) },
      });
      return this.toProfileResponse(user, jobTitle);
    });
  }

  private async getJobTitle(manager: EntityManager, userId: string): Promise<string | null> {
    const profile = await manager.findOne(ManagerProfile, { where: { userId } });
    return profile?.jobTitle ?? null;
  }

  private toProfileResponse(user: User, jobTitle: string | null): ProfileResponse {
    return {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      jobTitle,
      // Opaque FILE ID (field name kept for client compatibility) - resolve via GET /files/:id, never an object key.
      avatarKey: user.avatarFileId ?? null,
    };
  }

  onModuleInit(): void {
    // Avatar visibility is bounded by RLS on stored_file; the domain's own rule is what a COMPLETED direct upload means:
    // it becomes the caller's avatar, and the file it replaces is tombstoned.
    this.fileRegistry.register([FileKind.PROFILE_IMAGE], {
      canRead: async () => true,
      onUploadCompleted: async (manager, ctx, file) => {
        const before = await manager.findOneOrFail(User, { where: { id: ctx.userId } });
        await manager.update(User, ctx.userId, { avatarFileId: file.id });
        await this.retireAvatar(manager, before.avatarFileId);
        await this.auditService.record(manager, ctx, AuditAction.PROFILE_UPDATED, { targetUserId: ctx.userId, metadata: { fields: ['avatar'] } });
      },
    });
  }

  async uploadAvatar(ctx: AuthContext, buffer: Buffer): Promise<ProfileResponse> {
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const before = await manager.findOneOrFail(User, { where: { id: ctx.userId } });
      const file = await this.fileService.store(manager, {
        kind: FileKind.PROFILE_IMAGE,
        organisationId: ctx.organisationId!,
        workspaceId: ctx.workspaceId ?? null,
        resourceType: 'user',
        resourceId: ctx.userId,
        buffer,
        createdBy: ctx.userId,
      });
      await manager.update(User, ctx.userId, { avatarFileId: file.id });
      await this.retireAvatar(manager, before.avatarFileId);
      await this.auditService.record(manager, ctx, AuditAction.FILE_UPLOADED, { entityType: 'stored_file', entityId: file.id, metadata: { kind: file.kind, sizeBytes: file.sizeBytes } });
      await this.auditService.record(manager, ctx, AuditAction.PROFILE_UPDATED, {
        targetUserId: ctx.userId,
        metadata: { fields: ['avatar'] },
      });
      const user = await manager.findOneOrFail(User, { where: { id: ctx.userId } });
      const jobTitle = await this.getJobTitle(manager, ctx.userId);
      return this.toProfileResponse(user, jobTitle);
    });
  }

  /** Tombstones the replaced file (row kept as `DELETED`); its object is purged later by `storage:reconcile`, so a rolled-back transaction can never leave an AVAILABLE row whose object is already gone. */
  private async retireAvatar(manager: EntityManager, fileId: string | null | undefined): Promise<void> {
    if (!fileId) return;
    const file = await manager.findOne(StoredFile, { where: { id: fileId } });
    if (file) await this.fileService.tombstone(manager, file, { removeObject: false });
  }

  async deleteAvatar(ctx: AuthContext): Promise<ProfileResponse> {
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const before = await manager.findOneOrFail(User, { where: { id: ctx.userId } });
      await manager.query(`UPDATE core."user" SET avatar_file_id = NULL, avatar_key = NULL WHERE id = $1`, [ctx.userId]);
      await this.retireAvatar(manager, before.avatarFileId);
      await this.auditService.record(manager, ctx, AuditAction.PROFILE_UPDATED, {
        targetUserId: ctx.userId,
        metadata: { fields: ['avatar'] },
      });
      const user = await manager.findOneOrFail(User, { where: { id: ctx.userId } });
      const jobTitle = await this.getJobTitle(manager, ctx.userId);
      return this.toProfileResponse(user, jobTitle);
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
        // The true original login time, not this row's own created_at —
        // that's this FAMILY's most recent rotation, which for a
        // long-lived session could be months after the real login.
        // familyExpiresAt is fixed at family creation (see
        // RefreshTokenService), so it's always exactly ABSOLUTE_SESSION_TTL_MS
        // ahead of the true start.
        createdAt: new Date(row.familyExpiresAt.getTime() - ABSOLUTE_SESSION_TTL_MS),
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
