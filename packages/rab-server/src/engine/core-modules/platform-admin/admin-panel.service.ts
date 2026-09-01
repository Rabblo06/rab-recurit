import { HealthStatus, HealthStatusType } from '@rab/shared';
import { Injectable, Logger } from '@nestjs/common';
import { TypeOrmHealthIndicator } from '@nestjs/terminus';
import nodemailer from 'nodemailer';

import { AuditAction, AuditService } from '../audit/audit.service';
import { EnvironmentService } from '../environment/environment.service';
import { SecretEncryptionService } from '../secret-encryption/secret-encryption.service';
import { StorageService } from '../storage/storage.service';
import { ThrottlerRedisClientProvider } from '../throttler/throttler-redis-client.provider';
import { AuthContext } from '../tenant/auth-context.interface';
import { TenantContextService } from '../tenant/tenant-context.service';
import { WORKER_HEARTBEAT_KEY, WORKER_HEARTBEAT_TTL_SECONDS } from '../../../queue-worker/heartbeat.constants';
import { PlatformConfig, User } from '../../../modules/identity/entities';
import { MaintenanceModeDto } from './dto/maintenance-mode.dto';
import { TestSmtpDto } from './dto/test-smtp.dto';
import { UpdateSmtpConfigDto } from './dto/update-smtp-config.dto';
import { assertPublicHost } from './utils/assert-public-host.util';

export interface RecentUserItem {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  createdAt: Date;
}

export interface GeneralInfo {
  version: string;
  // Always null — there's no update-check mechanism in this codebase (no
  // registry/release feed this self-hosted app polls against). Present so
  // the field structurally exists rather than silently fabricated; a real
  // value needs its own explicit decision (what feed, how often, etc.),
  // not a guess folded into this endpoint.
  latestVersion: string | null;
}

export interface SmtpConfigResponse {
  host: string | null;
  port: number | null;
  encryption: string | null;
  username: string | null;
  fromName: string | null;
  fromEmail: string | null;
  hasPassword: boolean;
}

export interface ConfigResponse {
  authentication: { method: string };
  smtp: SmtpConfigResponse;
  storage: { driver: string };
  maintenanceMode: { enabled: boolean; message: string | null };
}

export interface HealthCheckItem {
  name: string;
  status: HealthStatusType;
  detail?: string;
}

@Injectable()
export class AdminPanelService {
  private readonly logger = new Logger(AdminPanelService.name);

  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly auditService: AuditService,
    private readonly env: EnvironmentService,
    private readonly secretEncryption: SecretEncryptionService,
    private readonly typeOrmHealth: TypeOrmHealthIndicator,
    private readonly redisClient: ThrottlerRedisClientProvider,
    private readonly storageService: StorageService,
  ) {}

  getGeneral(): GeneralInfo {
    return {
      version: this.env.get('APP_VERSION') || 'dev',
      latestVersion: null,
    };
  }

  /**
   * Explicit organisationId filter (layer 3, CLAUDE.md §5.2), not just RLS
   * (layer 4) — `user` is one of the four tables that only gets ENABLE, not
   * FORCE, RLS (pre-auth login lookup needs it readable before tenant
   * context exists), so a query relying on RLS alone here would return
   * every organisation's users the moment the connecting DB role owns the
   * table (as `rab_owner` currently does for all runtime traffic — see the
   * SECURITY FINDING flagged in this session for the fix at the connection
   * level). This filter makes the endpoint correct independent of that.
   */
  async getRecentUsers(ctx: AuthContext, search?: string): Promise<RecentUserItem[]> {
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const qb = manager
        .createQueryBuilder(User, 'u')
        .where('u.organisationId = :orgId', { orgId: ctx.organisationId })
        .andWhere('u.deletedAt IS NULL');
      const trimmed = search?.trim();
      if (trimmed) {
        qb.andWhere('(u.firstName ILIKE :s OR u.lastName ILIKE :s OR u.email ILIKE :s)', { s: `%${trimmed}%` });
      }
      qb.orderBy('u.createdAt', 'DESC').limit(trimmed ? 20 : 10);
      const users = await qb.getMany();
      return users.map((u) => ({
        id: u.id,
        firstName: u.firstName,
        lastName: u.lastName,
        email: u.email,
        createdAt: u.createdAt,
      }));
    });
  }

  async getConfig(ctx: AuthContext): Promise<ConfigResponse> {
    return this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const config = await manager
        .createQueryBuilder(PlatformConfig, 'pc')
        .addSelect('pc.smtp_password_encrypted')
        .where('pc.organisation_id = :id', { id: ctx.organisationId })
        .getOne();
      const hasPassword = Boolean(config?.smtpPasswordEncrypted);

      return {
        authentication: { method: 'email_password' },
        smtp: {
          host: config?.smtpHost ?? null,
          port: config?.smtpPort ?? null,
          encryption: config?.smtpEncryption ?? null,
          username: config?.smtpUsername ?? null,
          fromName: config?.smtpFromName ?? null,
          fromEmail: config?.smtpFromEmail ?? null,
          hasPassword,
        },
        storage: { driver: this.env.get('STORAGE_DRIVER') },
        maintenanceMode: {
          enabled: config?.maintenanceModeEnabled ?? false,
          message: config?.maintenanceModeMessage ?? null,
        },
      };
    });
  }

  async updateSmtpConfig(ctx: AuthContext, dto: UpdateSmtpConfigDto): Promise<ConfigResponse> {
    await this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const existing = await manager.findOne(PlatformConfig, { where: { organisationId: ctx.organisationId! } });
      const passwordEncrypted = dto.password
        ? this.secretEncryption.encrypt(dto.password)
        : existing?.smtpPasswordEncrypted;

      const values = {
        organisationId: ctx.organisationId!,
        smtpHost: dto.host,
        smtpPort: dto.port,
        smtpEncryption: dto.encryption,
        smtpUsername: dto.username,
        smtpFromName: dto.fromName,
        smtpFromEmail: dto.fromEmail,
        smtpPasswordEncrypted: passwordEncrypted,
        updatedBy: ctx.userId,
      };

      if (existing) {
        await manager.update(PlatformConfig, { organisationId: ctx.organisationId! }, values);
      } else {
        await manager.insert(PlatformConfig, values);
      }

      // Never the password, not even hashed — see AuditService.record's own doc comment.
      await this.auditService.record(manager, ctx, AuditAction.PLATFORM_CONFIG_SMTP_UPDATED, {
        metadata: { host: dto.host, port: dto.port, encryption: dto.encryption },
      });
    });
    return this.getConfig(ctx);
  }

  async setMaintenanceMode(ctx: AuthContext, dto: MaintenanceModeDto): Promise<ConfigResponse> {
    await this.tenantContext.runInTenantContext(ctx, async (manager) => {
      const existing = await manager.findOne(PlatformConfig, { where: { organisationId: ctx.organisationId! } });
      const values = {
        organisationId: ctx.organisationId!,
        maintenanceModeEnabled: dto.enabled,
        maintenanceModeMessage: dto.message,
        updatedBy: ctx.userId,
      };
      if (existing) {
        await manager.update(PlatformConfig, { organisationId: ctx.organisationId! }, values);
      } else {
        await manager.insert(PlatformConfig, values);
      }
      await this.auditService.record(manager, ctx, AuditAction.PLATFORM_CONFIG_MAINTENANCE_MODE_CHANGED, {
        metadata: { enabled: dto.enabled },
      });
    });
    return this.getConfig(ctx);
  }

  /**
   * Tested against unsaved/candidate values — `password` omitted means
   * "use whatever is already stored" so re-testing an unchanged credential
   * doesn't require re-entering it. Never reflects the raw connection
   * error to the caller (rab-workforce-architecture.md-style SSRF
   * mitigation — this opens a real socket to an admin-supplied host:port).
   *
   * `assertPublicHost` resolves `dto.host` and rejects loopback/private/
   * link-local/metadata addresses before nodemailer ever opens a socket —
   * see its own doc comment for the residual DNS-rebinding risk this
   * doesn't close.
   */
  async testSmtp(ctx: AuthContext, dto: TestSmtpDto): Promise<{ ok: boolean; message: string }> {
    try {
      await assertPublicHost(dto.host);
    } catch {
      return { ok: false, message: 'Could not connect. Check the host, port and credentials.' };
    }

    let password = dto.password;
    if (!password) {
      const stored = await this.tenantContext.runInTenantContext(ctx, (manager) =>
        manager
          .createQueryBuilder(PlatformConfig, 'pc')
          .addSelect('pc.smtp_password_encrypted')
          .where('pc.organisation_id = :id', { id: ctx.organisationId })
          .getOne(),
      );
      if (stored?.smtpPasswordEncrypted) {
        password = this.secretEncryption.decrypt(stored.smtpPasswordEncrypted);
      }
    }

    const transport = nodemailer.createTransport({
      host: dto.host,
      port: dto.port,
      secure: dto.encryption === 'tls',
      ignoreTLS: dto.encryption === 'none',
      auth: dto.username && password ? { user: dto.username, pass: password } : undefined,
    });

    try {
      await transport.verify();
      if (dto.sendTo) {
        await transport.sendMail({
          to: dto.sendTo,
          from: dto.username || dto.sendTo,
          subject: 'rab — SMTP test email',
          text: 'This is a test email from your rab workspace Admin Panel.',
        });
      }
      return { ok: true, message: dto.sendTo ? 'Test email sent.' : 'Connection succeeded.' };
    } catch (error) {
      this.logger.warn(`SMTP test failed for host ${dto.host}: ${(error as Error).message}`);
      return { ok: false, message: 'Could not connect. Check the host, port and credentials.' };
    }
  }

  async getHealth(): Promise<HealthCheckItem[]> {
    const [database, email, storage, redis, worker] = await Promise.all([
      this.checkDatabase(),
      this.checkEmail(),
      this.checkStorage(),
      this.checkRedis(),
      this.checkWorker(),
    ]);
    return [
      database,
      { name: 'API', status: HealthStatus.OPERATIONAL },
      email,
      storage,
      redis,
      worker,
    ];
  }

  private async checkDatabase(): Promise<HealthCheckItem> {
    try {
      await this.typeOrmHealth.pingCheck('database');
      return { name: 'Database', status: HealthStatus.OPERATIONAL };
    } catch (error) {
      return { name: 'Database', status: HealthStatus.DOWN, detail: (error as Error).message };
    }
  }

  private async checkEmail(): Promise<HealthCheckItem> {
    if (this.env.get('EMAIL_DRIVER') !== 'SMTP') {
      return { name: 'Email / SMTP', status: HealthStatus.UNKNOWN, detail: 'No SMTP driver configured.' };
    }
    try {
      const transport = nodemailer.createTransport({
        host: this.env.get('EMAIL_SMTP_HOST'),
        port: this.env.get('EMAIL_SMTP_PORT'),
        secure: !this.env.get('EMAIL_SMTP_NO_TLS') && this.env.get('EMAIL_SMTP_PORT') === 465,
        ignoreTLS: this.env.get('EMAIL_SMTP_NO_TLS'),
      });
      await transport.verify();
      return { name: 'Email / SMTP', status: HealthStatus.OPERATIONAL };
    } catch {
      return { name: 'Email / SMTP', status: HealthStatus.DOWN };
    }
  }

  private async checkStorage(): Promise<HealthCheckItem> {
    try {
      await this.storageService.healthCheck();
      return { name: 'Storage', status: HealthStatus.OPERATIONAL };
    } catch (error) {
      return { name: 'Storage', status: HealthStatus.DOWN, detail: (error as Error).message };
    }
  }

  private async checkRedis(): Promise<HealthCheckItem> {
    try {
      const pong = await this.redisClient.client.ping();
      return { name: 'Redis / Cache', status: pong === 'PONG' ? HealthStatus.OPERATIONAL : HealthStatus.DEGRADED };
    } catch {
      return { name: 'Redis / Cache', status: HealthStatus.DOWN };
    }
  }

  private async checkWorker(): Promise<HealthCheckItem> {
    try {
      const value = await this.redisClient.client.get(WORKER_HEARTBEAT_KEY);
      if (!value) return { name: 'Worker', status: HealthStatus.UNKNOWN, detail: 'No heartbeat seen yet.' };
      const ageSeconds = (Date.now() - Number(value)) / 1000;
      if (ageSeconds > WORKER_HEARTBEAT_TTL_SECONDS) {
        return { name: 'Worker', status: HealthStatus.DEGRADED, detail: 'Heartbeat is stale.' };
      }
      return { name: 'Worker', status: HealthStatus.OPERATIONAL };
    } catch {
      return { name: 'Worker', status: HealthStatus.UNKNOWN };
    }
  }
}
