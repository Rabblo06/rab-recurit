import { Injectable, Logger, Optional } from '@nestjs/common';
import nodemailer from 'nodemailer';
import { DataSource } from 'typeorm';

import { AuditEventQueueService } from '../audit-events/audit-event-queue.service';
import { EnvironmentService } from '../environment/environment.service';
import { FileService } from '../storage/file.service';
import { AuthContext } from '../tenant/auth-context.interface';
import { ThrottlerRedisClientProvider } from '../throttler/throttler-redis-client.provider';
import { AUDIT_PREAUTH_BACKLOG_LIMIT } from '../../worker-shared/audit-event.contract';
import { PROVISIONER_HEARTBEAT_KEY, WORKER_HEARTBEAT_KEY, WORKER_HEARTBEAT_TTL_SECONDS } from '../../worker-shared/heartbeat.constants';
import { assertActivePlatformAdmin, withTimeout } from './admin-actor';
import { PlatformAdminService } from './platform-admin.service';
import { UpgradeStatus, UpgradeStatusService } from '../upgrade/upgrade-status.service';

/** The panel's status model (mockup v2): healthy / warning / degraded / unavailable. */
export type AdminHealthStatus = 'healthy' | 'warning' | 'degraded' | 'unavailable';

export interface AdminHealthCard {
  key: 'database' | 'redis' | 'worker' | 'provisioner' | 'email' | 'storage' | 'auditEvents' | 'upgrade';
  status: AdminHealthStatus;
  /** Fixed, operator-facing text built here — never a raw error message, host name, URL or credential. */
  detail: string;
  latencyMs: number | null;
}

export interface AdminHealthReport {
  checkedAt: string;
  cards: AdminHealthCard[];
  /** Cards that are not `healthy` (the tab badge). */
  attention: number;
  /** OWNER-DB-ULTIMATE Part B3: the upgrade banner's fields (never an error message). Absent when the read failed. */
  upgrade?: UpgradeStatus;
}

export const ADMIN_HEALTH_CACHE_KEY = 'rab:admin-panel:health:v1';
export const ADMIN_HEALTH_CACHE_SECONDS = 10;
export const ADMIN_HEALTH_PROBE_TIMEOUT_MS = 2_000;
const SLOW_MS = 500;

/**
 * Crewflow Platform Admin Panel — Health tab probes. Every probe is bounded at 2 s (a hung SMTP server or Redis can never
 * hold the request), the probes run in parallel, and the result is cached in Redis for 10 s so 15-second polling by
 * several admins does not multiply probes (a Redis failure just skips the cache). Details are fixed strings composed
 * here: no raw `error.message`, no host names, no URLs (the old `/admin/health` returned raw DB/storage error text).
 *
 * Not measured (no source yet, shown as such in the UI): per-queue failure rates (BullMQ metrics are not enabled on the
 * Workers), "last email sent", stale uploads.
 */
@Injectable()
export class AdminHealthService {
  private readonly logger = new Logger(AdminHealthService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly env: EnvironmentService,
    private readonly redis: ThrottlerRedisClientProvider,
    private readonly fileService: FileService,
    private readonly platformAdmin: PlatformAdminService,
    // X1.1: the security audit event shipper (global via AuditModule); optional so a graph without it still builds.
    @Optional() private readonly auditEvents?: AuditEventQueueService,
    // OWNER-DB-ULTIMATE Part B3 (global UpgradeModule); optional so a graph without it still builds.
    @Optional() private readonly upgrades?: UpgradeStatusService,
  ) {}

  async report(actor: Pick<AuthContext, 'userId'>): Promise<AdminHealthReport> {
    await assertActivePlatformAdmin(this.platformAdmin, actor);
    try {
      const cached = await withTimeout(this.redis.client.get(ADMIN_HEALTH_CACHE_KEY), 500);
      if (cached) {
        const parsed = JSON.parse(cached) as AdminHealthReport;
        if (Array.isArray(parsed.cards)) return parsed;
      }
    } catch {
      // no cache: probe live
    }
    const cards = await Promise.all([
      this.probe('database', () => this.database()),
      this.probe('redis', () => this.redisCard()),
      this.probe('worker', () => this.heartbeat('worker', WORKER_HEARTBEAT_KEY, 'Worker')),
      this.probe('provisioner', () => this.heartbeat('provisioner', PROVISIONER_HEARTBEAT_KEY, 'Provisioner')),
      this.probe('email', () => this.email()),
      this.probe('storage', () => this.storage()),
      this.probe('auditEvents', () => this.auditEventsCard()),
    ]);
    const upgrade = this.upgrades ? await withTimeout(this.upgrades.status(), ADMIN_HEALTH_PROBE_TIMEOUT_MS).catch(() => undefined) : undefined;
    if (upgrade) cards.push(upgradeCard(upgrade));
    const report: AdminHealthReport = {
      checkedAt: new Date().toISOString(),
      cards,
      attention: cards.filter((c) => c.status !== 'healthy').length,
      ...(upgrade ? { upgrade } : {}),
    };
    try {
      await withTimeout(this.redis.client.set(ADMIN_HEALTH_CACHE_KEY, JSON.stringify(report), 'EX', ADMIN_HEALTH_CACHE_SECONDS), 500);
    } catch {
      // cache is best effort
    }
    return report;
  }

  /** Bounds one probe at 2 s; a timeout or any throw becomes a fixed "unavailable" card (never the error text). */
  private async probe(key: AdminHealthCard['key'], fn: () => Promise<AdminHealthCard>): Promise<AdminHealthCard> {
    try {
      return await withTimeout(fn(), ADMIN_HEALTH_PROBE_TIMEOUT_MS);
    } catch (error) {
      this.logger.debug(`health probe ${key} failed: ${(error as Error).message}`);
      const timedOut = (error as Error).message === 'timeout';
      return { key, status: 'unavailable', detail: timedOut ? 'No answer within 2 seconds.' : 'Not reachable.', latencyMs: null };
    }
  }

  private async database(): Promise<AdminHealthCard> {
    const started = Date.now();
    await this.dataSource.query('SELECT 1');
    const latencyMs = Date.now() - started;
    const pool = (this.dataSource.driver as unknown as { master?: { totalCount?: number; idleCount?: number; options?: { max?: number } } }).master;
    const inUse = typeof pool?.totalCount === 'number' && typeof pool?.idleCount === 'number' ? pool.totalCount - pool.idleCount : null;
    const max = typeof pool?.options?.max === 'number' ? pool.options.max : null;
    const poolText = inUse !== null && max !== null ? ` · pool ${inUse} of ${max} in use` : '';
    return { key: 'database', status: latencyMs > SLOW_MS ? 'warning' : 'healthy', detail: `PostgreSQL · ${latencyMs} ms${poolText}`, latencyMs };
  }

  private async redisCard(): Promise<AdminHealthCard> {
    const started = Date.now();
    const pong = await this.redis.client.ping();
    const latencyMs = Date.now() - started;
    if (pong !== 'PONG') return { key: 'redis', status: 'degraded', detail: 'Reachable but did not answer PING correctly.', latencyMs };
    let passwordSet = false;
    try {
      const url = new URL(this.env.get('REDIS_URL'));
      passwordSet = url.password !== '';
    } catch {
      passwordSet = false;
    }
    return {
      key: 'redis',
      status: passwordSet ? (latencyMs > SLOW_MS ? 'warning' : 'healthy') : 'warning',
      detail: `Reachable · ${latencyMs} ms${passwordSet ? '' : ' · no password set'}`,
      latencyMs,
    };
  }

  private async heartbeat(key: 'worker' | 'provisioner', redisKey: string, label: string): Promise<AdminHealthCard> {
    const value = await this.redis.client.get(redisKey);
    const at = Number(value);
    if (!value || !Number.isFinite(at)) return { key, status: 'unavailable', detail: `No ${label.toLowerCase()} heartbeat seen.`, latencyMs: null };
    const age = Math.max(0, Math.round((Date.now() - at) / 1000));
    const stale = age > WORKER_HEARTBEAT_TTL_SECONDS;
    return { key, status: stale ? 'degraded' : 'healthy', detail: `Heartbeat ${age} s ago${stale ? ' (stale)' : ''}`, latencyMs: null };
  }

  private async email(): Promise<AdminHealthCard> {
    const driver = this.env.get('EMAIL_DRIVER');
    const delivery = this.env.get('EMAIL_DELIVERY_ENABLED');
    if (driver === 'LOGGER') return { key: 'email', status: 'warning', detail: 'Driver: Logger — emails are written to the log, not sent.', latencyMs: null };
    if (driver === 'RESEND') {
      const configured = Boolean(this.env.get('RESEND_API_KEY'));
      return {
        key: 'email',
        status: configured && delivery ? 'healthy' : 'warning',
        detail: `Driver: Resend (from server settings) · API key ${configured ? 'set' : 'not set'}${delivery ? '' : ' · delivery turned off'} · not probed`,
        latencyMs: null,
      };
    }
    if (driver === 'SMTP') {
      const host = this.env.get('EMAIL_SMTP_HOST');
      if (!host) return { key: 'email', status: 'unavailable', detail: 'Driver: SMTP · host not set.', latencyMs: null };
      const transport = nodemailer.createTransport({
        host,
        port: this.env.get('EMAIL_SMTP_PORT'),
        secure: !this.env.get('EMAIL_SMTP_NO_TLS') && this.env.get('EMAIL_SMTP_PORT') === 465,
        ignoreTLS: this.env.get('EMAIL_SMTP_NO_TLS'),
        connectionTimeout: ADMIN_HEALTH_PROBE_TIMEOUT_MS,
        greetingTimeout: ADMIN_HEALTH_PROBE_TIMEOUT_MS,
        socketTimeout: ADMIN_HEALTH_PROBE_TIMEOUT_MS,
      });
      const started = Date.now();
      try {
        await transport.verify();
      } finally {
        transport.close();
      }
      const latencyMs = Date.now() - started;
      return { key: 'email', status: delivery ? 'healthy' : 'warning', detail: `Driver: SMTP (from server settings) · ${latencyMs} ms${delivery ? '' : ' · delivery turned off'}`, latencyMs };
    }
    return { key: 'email', status: 'unavailable', detail: 'Driver not recognised.', latencyMs: null };
  }

  /**
   * X1.1 owner guard (2026-11-12): failed-login audit events dropped because the audit queue's backlog was over
   * AUDIT_PREAUTH_BACKLOG_LIMIT. Total = the durable Redis counter across every process; "this API process" = the local one.
   */
  private async auditEventsCard(): Promise<AdminHealthCard> {
    if (!this.auditEvents) return auditEventsHealthCard(null);
    return auditEventsHealthCard(await this.auditEvents.preAuthDropReport());
  }

  private async storage(): Promise<AdminHealthCard> {
    const started = Date.now();
    await this.fileService.healthProbe();
    const latencyMs = Date.now() - started;
    const driver = this.env.get('STORAGE_DRIVER');
    return { key: 'storage', status: latencyMs > SLOW_MS * 2 ? 'warning' : 'healthy', detail: `${driver === 'S3' ? 'S3-compatible' : 'Local disk'} · probe ${latencyMs} ms`, latencyMs };
  }
}

/** The Health tab card for the security audit event shipper (pure; exported for its unit test). Fixed strings only. */
export function auditEventsHealthCard(report: { enabled: boolean; total: number | null; sinceProcessStart: number; lastBacklog: number | null } | null): AdminHealthCard {
  const limit = AUDIT_PREAUTH_BACKLOG_LIMIT.toLocaleString('en-GB');
  if (!report || !report.enabled) // Production refuses to start without a sink (BC-07), so this is development / test only: not an attention item.
    return { key: 'auditEvents', status: 'healthy', detail: 'Off-host audit copy is off (no audit sink configured; development only).', latencyMs: null };
  const total = report.total === null ? 'total unknown (Redis did not answer)' : `${report.total} dropped in total`;
  const backlog = report.lastBacklog === null ? '' : ` · queue backlog ${report.lastBacklog}`;
  const dropped = (report.total ?? 0) > 0 || report.sinceProcessStart > 0;
  return {
    key: 'auditEvents',
    status: report.total === null ? 'warning' : dropped ? 'warning' : 'healthy',
    detail: `Failed-login events over the ${limit} backlog: ${total} · ${report.sinceProcessStart} by this API process${backlog}`,
    latencyMs: null,
  };
}

/**
 * OWNER-DB-ULTIMATE Part B3: the upgrade card (the admin banner). Fixed text built from the logbook's fields only: the step
 * name, versions and attempt, never error_message.
 */
export function upgradeCard(u: UpgradeStatus): AdminHealthCard {
  const blocked = (u.workspaces ?? []).filter((w) => w.blocked);
  const failedServed = (u.workspaces ?? []).filter((w) => !w.blocked);
  // Owner D2/D3: which workspace and why (workspace id, step, error class; never a message).
  const ws =
    (blocked.length
      ? ` · ${blocked.length} workspace(s) BLOCKED (503, jobs paused): ` + blocked.slice(0, 5).map((w) => `${w.workspaceId} ${w.step ?? '-'} (${w.errorClass})`).join(', ')
      : '') +
    (failedServed.length
      ? ` · ${failedServed.length} workspace(s) failed a data step but serve normally: ` + failedServed.slice(0, 5).map((w) => `${w.workspaceId} ${w.step ?? '-'} (${w.errorClass})`).join(', ')
      : '');
  const where = (u.step ? ` · last step ${u.step} (attempt ${u.attempt ?? '?'}${u.forced ? ', forced' : ''})` : '') + ws;
  switch (u.state) {
    case 'ok':
      return { key: 'upgrade', status: 'healthy', detail: `Version ${u.appVersion} · upgrade complete${where}`, latencyMs: null };
    case 'failed':
      return { key: 'upgrade', status: 'degraded', detail: `Upgrade failed · version ${u.appVersion}${where}. The API serves; fix the step and restart.`, latencyMs: null };
    case 'behind':
      return { key: 'upgrade', status: 'warning', detail: `Version ${u.appVersion} · upgrade not complete${where}`, latencyMs: null };
    case 'ahead':
      return { key: 'upgrade', status: 'warning', detail: `Version ${u.appVersion} runs on a database upgraded by a newer version (rollback)${where}`, latencyMs: null };
    case 'none':
      return { key: 'upgrade', status: 'warning', detail: `Version ${u.appVersion ?? 'unknown'} · no upgrade recorded yet`, latencyMs: null };
    default:
      return { key: 'upgrade', status: 'unavailable', detail: 'Upgrade status not readable.', latencyMs: null };
  }
}
