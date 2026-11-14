import { Injectable, Logger, Optional } from '@nestjs/common';
import nodemailer from 'nodemailer';
import { DataSource } from 'typeorm';

import { AuditAction, AuditService } from '../audit/audit.service';
import { AuditEventQueueService } from '../audit-events/audit-event-queue.service';
import { EnvironmentService } from '../environment/environment.service';
import { FileService } from '../storage/file.service';
import { AuthContext } from '../tenant/auth-context.interface';
import { TenantContextService } from '../tenant/tenant-context.service';
import { ThrottlerRedisClientProvider } from '../throttler/throttler-redis-client.provider';
import { AUDIT_PREAUTH_BACKLOG_LIMIT } from '../../worker-shared/audit-event.contract';
import { PROVISIONER_HEARTBEAT_KEY, WORKER_HEARTBEAT_KEY, WORKER_HEARTBEAT_TTL_SECONDS, WORKER_SCHEDULER_STATUS_KEY } from '../../worker-shared/heartbeat.constants';
import { CONSUMER_QUEUES, LEGACY_BULL_PREFIX, SCAN_QUEUE_NAMES, resolveScanPrefix } from '../../worker-shared/queue-registry';
import { assertActivePlatformAdmin, withTimeout } from './admin-actor';
import { apiIndicator } from './indicators/api.indicator';
import { databaseIndicator } from './indicators/database.indicator';
import { redisIndicator } from './indicators/redis.indicator';
import { schedulerIndicator } from './indicators/scheduler.indicator';
import { HealthQueueRef, heartbeatAgeSeconds, workerIndicator } from './indicators/worker.indicator';
import { PlatformAdminService } from './platform-admin.service';
import { UpgradeStatus, UpgradeStatusService } from '../upgrade/upgrade-status.service';

/** The panel's status model (mockup v2): healthy / warning / degraded / unavailable. */
export type AdminHealthStatus = 'healthy' | 'warning' | 'degraded' | 'unavailable';

export interface AdminHealthCard {
  key: 'api' | 'database' | 'redis' | 'worker' | 'scheduler' | 'provisioner' | 'email' | 'storage' | 'auditEvents' | 'upgrade';
  status: AdminHealthStatus;
  /** Fixed, operator-facing text built here — never a raw error message, host name, URL or credential. */
  detail: string;
  latencyMs: number | null;
  /** X2.4: the indicator's numbers as label/value lines (fixed labels, numbers or allowlisted tokens only). */
  facts?: AdminHealthFact[];
}

export interface AdminHealthFact {
  label: string;
  value: string;
}

export interface AdminHealthReport {
  checkedAt: string;
  cards: AdminHealthCard[];
  /** Cards that are not `healthy` (the tab badge). */
  attention: number;
  /** OWNER-DB-ULTIMATE Part B3: the upgrade banner's fields (never an error message). Absent when the read failed. */
  upgrade?: UpgradeStatus;
}

/** X2.4: the report is cached IN THIS PROCESS for 10 s (the indicators never write to Redis). */
export const ADMIN_HEALTH_CACHE_MS = 10_000;
/**
 * X2.4 review R2: a manual Refresh re-probes only when the cached report is at least this old; a younger report is
 * returned as is. Together with the single in-flight probe set this bounds `?refresh=1` to one probe set per 5 s per
 * process, however many requests arrive.
 */
export const ADMIN_HEALTH_REFRESH_MIN_AGE_MS = 5_000;
/** X2.4 (owner assumption, see the PR): one `admin.health_viewed` row per admin per process at most every 5 minutes, plus every manual Refresh. */
export const ADMIN_HEALTH_AUDIT_INTERVAL_MS = 5 * 60_000;
/** X2.4 review R1: the audit write is bounded too, so the page can never hang on it (still fail-closed). */
export const ADMIN_HEALTH_AUDIT_TIMEOUT_MS = 2_000;
const AUDIT_DEDUPE_MAX_ENTRIES = 1_000;
export const ADMIN_HEALTH_PROBE_TIMEOUT_MS = 2_000;
const SLOW_MS = 500;

/**
 * Crewflow Platform Admin Panel — Health tab probes. Every probe is bounded at 2 s (a hung SMTP server or Redis can never
 * hold the request), the probes run in parallel, and one failing probe only turns its own card `unavailable` — the page
 * still answers. Details are fixed strings composed here: no raw `error.message`, no host names, no URLs (the old
 * `/admin/health` returned raw DB/storage error text).
 *
 * Phase X Part 2, X2.4 ("health monitoring, the Twenty way"; Twenty: `admin-panel/admin-panel-health.service.ts` with
 * one file per indicator under `admin-panel/indicators/`): the API, database (connections vs max_connections), Redis
 * (memory and version), Worker (heartbeat + per-queue failed/waiting) and BullMQ scheduler indicators live one per file in
 * `./indicators/`. Every indicator is READ-ONLY: statistics views and settings on PostgreSQL, read commands only on Redis
 * (`HealthRedisReader`). The report is cached for 10 s in process memory, never in Redis (Twenty keeps its last known
 * state in memory too: `health-state-manager.util.ts`), so 15-second polling by several admins does not multiply probes.
 * The cache is per API process (not shared across replicas). There is no external alerting here (as in Twenty); an
 * uptime monitor on `/healthz` covers "the API is down".
 *
 * ADDING AN INDICATOR is one more entry: a key in `AdminHealthCard['key']`, a probe line in `report()` (usually a function
 * in `./indicators/`), and a label in the front's `CARD_LABEL`. Nothing else registers it.
 *
 * Access is audited: `admin.health_viewed` in the admin's organisation, at most once per admin per process every
 * 5 minutes (the tab polls every 15 s), and on a manual Refresh (`?refresh=1`; at most one refresh row per admin per
 * 5 s). The audit write is bounded at 2 s and fails closed: when it fails or times out, the request fails. (The panel's
 * other audited reads are the ones that show a person's data, such as a user search or a user summary; this one shows
 * none. Whether this view should be best-effort instead is an open owner decision.)
 *
 * A Refresh re-probes only when the cached report is at least 5 s old, and every caller that needs a live report shares
 * ONE in-flight probe set, so `?refresh=1` cannot multiply probes.
 */
@Injectable()
export class AdminHealthService {
  private readonly logger = new Logger(AdminHealthService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly env: EnvironmentService,
    private readonly redis: ThrottlerRedisClientProvider,
    private readonly fileService: FileService,
    private readonly audit: AuditService,
    private readonly tenantContext: TenantContextService,
    private readonly platformAdmin: PlatformAdminService,
    // X1.1: the security audit event shipper (global via AuditModule); optional so a graph without it still builds.
    @Optional() private readonly auditEvents?: AuditEventQueueService,
    // OWNER-DB-ULTIMATE Part B3 (global UpgradeModule); optional so a graph without it still builds.
    @Optional() private readonly upgrades?: UpgradeStatusService,
  ) {}

  private cache: { at: number; report: AdminHealthReport } | null = null;
  /** X2.4 review R2: the one probe set in flight, shared by every caller that needs a live report. */
  private inflight: Promise<AdminHealthReport> | null = null;
  /** X2.4 audit dedupe: the acting admin's user id -> when this process last wrote their `admin.health_viewed` row. */
  private readonly lastAudited = new Map<string, number>();
  /** X2.4 review R2: the acting admin's user id -> when this process last wrote their REFRESH row. */
  private readonly lastRefreshAudited = new Map<string, number>();

  async report(actor: Pick<AuthContext, 'userId' | 'organisationId' | 'inspectedBy'>, opts: { refresh?: boolean } = {}): Promise<AdminHealthReport> {
    await assertActivePlatformAdmin(this.platformAdmin, actor);
    const refresh = opts.refresh === true;
    await this.auditView(actor, refresh);
    const age = this.cache ? Date.now() - this.cache.at : Number.POSITIVE_INFINITY;
    if (this.cache && age < (refresh ? ADMIN_HEALTH_REFRESH_MIN_AGE_MS : ADMIN_HEALTH_CACHE_MS)) return this.cache.report;
    this.inflight ??= this.probeAll().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async probeAll(): Promise<AdminHealthReport> {
    const cards = await Promise.all([
      this.probe('api', async () => apiIndicator({ version: this.env.get('APP_VERSION') || 'dev', commit: this.env.get('APP_GIT_COMMIT') ?? null, nodeVersion: process.version, uptimeSeconds: process.uptime() })),
      this.probe('database', () => databaseIndicator(this.dataSource)),
      this.probe('redis', () => redisIndicator(this.redis.client, this.redisPasswordSet())),
      this.probe('worker', () => workerIndicator(this.redis.client, { heartbeatKey: WORKER_HEARTBEAT_KEY, heartbeatTtlSeconds: WORKER_HEARTBEAT_TTL_SECONDS, queues: this.healthQueues() })),
      this.probe('scheduler', () => schedulerIndicator(this.redis.client, { configuredMode: this.schedulerMode(), statusKey: WORKER_SCHEDULER_STATUS_KEY, fallbackPrefix: this.scanPrefix(), scanQueues: SCAN_QUEUE_NAMES })),
      this.probe('provisioner', () => this.heartbeat('provisioner', PROVISIONER_HEARTBEAT_KEY, 'Provisioner')),
      this.probe('email', () => this.email()),
      this.probe('storage', () => this.storage()),
      this.probe('auditEvents', () => this.auditEventsCard()),
    ]);
    // OWNER-DB-ULTIMATE Part B: the upgrade card (state, step, versions, attempt; never error_message), bounded like a probe.
    const upgrade = this.upgrades ? await withTimeout(this.upgrades.status(), ADMIN_HEALTH_PROBE_TIMEOUT_MS).catch(() => undefined) : undefined;
    if (upgrade) cards.push(upgradeCard(upgrade));
    const report: AdminHealthReport = {
      checkedAt: new Date().toISOString(),
      cards,
      attention: cards.filter((c) => c.status !== 'healthy').length,
      ...(upgrade ? { upgrade } : {}),
    };
    this.cache = { at: Date.now(), report };
    return report;
  }

  /**
   * X2.4: `admin.health_viewed` in the admin's own organisation — on a manual Refresh (at most one refresh row per admin
   * per 5 s), otherwise at most once per admin per process every 5 minutes. Runs before any probe, is bounded at 2 s and
   * fails closed (a failed or timed-out audit write fails the request, and the dedupe is only marked after the row is
   * written). A process restart resets the dedupe.
   */
  private async auditView(actor: Pick<AuthContext, 'userId' | 'organisationId' | 'inspectedBy'>, refresh: boolean): Promise<void> {
    const who = actor.inspectedBy ?? actor.userId;
    const now = Date.now();
    const last = this.lastAudited.get(who);
    const lastRefresh = this.lastRefreshAudited.get(who);
    const refreshDue = refresh && (lastRefresh === undefined || now - lastRefresh >= ADMIN_HEALTH_REFRESH_MIN_AGE_MS);
    const viewDue = last === undefined || now - last >= ADMIN_HEALTH_AUDIT_INTERVAL_MS;
    if (!refreshDue && !viewDue) return;
    await withTimeout(
      this.tenantContext.runInTenantContext({ organisationId: actor.organisationId, workspaceId: null, userId: actor.userId, role: '' }, (manager) =>
        this.audit.record(manager, actor, AuditAction.ADMIN_HEALTH_VIEWED, { metadata: { refresh: refreshDue } }),
      ),
      ADMIN_HEALTH_AUDIT_TIMEOUT_MS,
    );
    mark(this.lastAudited, who, now, ADMIN_HEALTH_AUDIT_INTERVAL_MS);
    if (refreshDue) mark(this.lastRefreshAudited, who, now, ADMIN_HEALTH_REFRESH_MIN_AGE_MS);
  }

  /** The registry's consumer queues (BullMQ's default `bull` prefix) and, in bullmq mode, the scan queues. */
  private healthQueues(): HealthQueueRef[] {
    const consumers = Object.values(CONSUMER_QUEUES).map((q) => ({ name: q.name, prefix: LEGACY_BULL_PREFIX }));
    if (this.schedulerMode() !== 'bullmq') return consumers;
    const prefix = this.scanPrefix();
    return [...consumers, ...SCAN_QUEUE_NAMES.map((name) => ({ name, prefix }))];
  }

  private schedulerMode(): 'interval' | 'bullmq' {
    const configured = this.env.get('WORKER_SCHEDULER');
    if (configured === 'bullmq' || configured === 'interval') return configured;
    return this.env.get('NODE_ENV') === 'production' ? 'bullmq' : 'interval';
  }

  private scanPrefix(): string {
    return resolveScanPrefix(this.env.get('NODE_ENV'), this.env.get('BULLMQ_PREFIX'));
  }

  private redisPasswordSet(): boolean {
    try {
      return new URL(this.env.get('REDIS_URL')).password !== '';
    } catch {
      return false;
    }
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

  private async heartbeat(key: 'provisioner', redisKey: string, label: string): Promise<AdminHealthCard> {
    const age = heartbeatAgeSeconds(await this.redis.client.get(redisKey), Date.now());
    if (age === null) return { key, status: 'unavailable', detail: `No ${label.toLowerCase()} heartbeat seen.`, latencyMs: null };
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

/** Records `who` at `now` in a bounded dedupe map (expired entries pruned first; cleared if still full). */
function mark(map: Map<string, number>, who: string, now: number, windowMs: number): void {
  if (map.size >= AUDIT_DEDUPE_MAX_ENTRIES) {
    for (const [id, at] of map) if (now - at >= windowMs) map.delete(id);
    if (map.size >= AUDIT_DEDUPE_MAX_ENTRIES) map.clear();
  }
  map.set(who, now);
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
  const where = u.step ? ` · last step ${u.step} (attempt ${u.attempt ?? '?'}${u.forced ? ', forced' : ''})` : '';
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
