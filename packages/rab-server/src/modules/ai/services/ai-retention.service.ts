import { AI_USAGE_RETENTION_DAYS } from '@rab/shared';
import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { AuditAction, AuditService } from '../../../engine/core-modules/audit/audit.service';
import { TenantContextService } from '../../../engine/core-modules/tenant/tenant-context.service';
import { organisationIds } from '../../../engine/worker-shared/maintenance-catalogue';
import { AI_RETENTION_BATCH_SIZE, AI_RETENTION_MAX_BATCHES_PER_ORG } from '../constants/ai.constants';
import { AiConfigService } from './ai-config.service';

export interface AiRetentionResult {
  ran: boolean;
  mode: 'off' | 'report' | 'purge';
  organisations: number;
  /** report: conversations that WOULD be purged; purge: conversations deleted (their messages cascade). */
  conversations: number;
  truncated: number;
  /** 7b: purge only — `core.ai_usage` ledger rows older than AI_USAGE_RETENTION_DAYS deleted (report mode: 0, never read). */
  usageRows: number;
}

/**
 * AI conversation retention (AI_RETENTION_DAYS, default 90 days since the last message). Runs ONLY through the authorised
 * database function `core.ai_purge_expired_conversations` (SECURITY DEFINER, owner crewflow), one ORGANISATION at a time
 * with that organisation bound as the tenant context — the function deletes nothing without a bound organisation, never
 * crosses organisations, and skips conversations with a queued/running turn. Immutable audit history is kept (audit_log
 * rows are never touched; only conversation content is purged).
 *
 * OFF by default (`AI_RETENTION_MODE=off`). `report` counts what would be purged (read-only); `purge` deletes — the owner
 * enables it after reviewing a report run. Scheduling and the cross-replica advisory lock live in the Worker job
 * (rab-worker `queues/rab-ai/ai-retention.job.ts`).
 */
@Injectable()
export class AiRetentionService {
  constructor(
    private readonly config: AiConfigService,
    private readonly tenantContext: TenantContextService,
    private readonly audit: AuditService,
  ) {}

  async runCycle(runtimeDataSource: DataSource, mode: 'off' | 'report' | 'purge' = this.config.retentionMode): Promise<AiRetentionResult> {
    const result: AiRetentionResult = { ran: false, mode, organisations: 0, conversations: 0, truncated: 0, usageRows: 0 };
    if (mode === 'off') return result;
    result.ran = true;
    for await (const organisationId of organisationIds(runtimeDataSource)) {
      result.organisations += 1;
      const outcome = await this.purgeOrganisation(organisationId, mode);
      result.conversations += outcome.conversations;
      if (outcome.truncated) result.truncated += 1;
      // 7b (D7-10): the usage ledger's own, longer retention — purge mode only (the SQL function only deletes).
      if (mode === 'purge') result.usageRows += await this.purgeUsage(organisationId);
    }
    return result;
  }

  /** One organisation, bound as the tenant context (system worker actor). Exported for tests. */
  async purgeOrganisation(organisationId: string, mode: 'report' | 'purge'): Promise<{ conversations: number; truncated: boolean }> {
    const ctx = { organisationId, workspaceId: null, userId: '', role: '', actorType: 'worker' as const };
    const days = this.config.retentionDays;
    if (mode === 'report') {
      const n = await this.tenantContext.runInTenantContext(ctx, async (m) => {
        const [row] = await m.query<Array<{ n: number }>>(`SELECT core.ai_purge_expired_conversations(make_interval(days => $1), $2, true) AS n`, [days, AI_RETENTION_BATCH_SIZE]);
        return Number(row?.n ?? 0);
      });
      return { conversations: n, truncated: false };
    }
    let total = 0;
    for (let batch = 0; batch < AI_RETENTION_MAX_BATCHES_PER_ORG; batch++) {
      const deleted = await this.tenantContext.runInTenantContext(ctx, async (m) => {
        const [row] = await m.query<Array<{ n: number }>>(`SELECT core.ai_purge_expired_conversations(make_interval(days => $1), $2, false) AS n`, [days, AI_RETENTION_BATCH_SIZE]);
        const n = Number(row?.n ?? 0);
        if (n > 0) {
          await this.audit.record(m, { organisationId, userId: '' }, AuditAction.AI_RETENTION_PURGED, {
            actorUserId: null,
            entityType: 'ai_conversation',
            metadata: { conversations: n, retentionDays: days },
          });
        }
        return n;
      });
      total += deleted;
      if (deleted < AI_RETENTION_BATCH_SIZE) return { conversations: total, truncated: false };
    }
    return { conversations: total, truncated: true };
  }

  /**
   * 7b (D7-10): `core.ai_usage` rows older than AI_USAGE_RETENTION_DAYS (400) for ONE organisation, through the authorised
   * SECURITY DEFINER function (it refuses anything under its SQL floor and deletes nothing without a bound organisation).
   * The count is audited in `ai.retention_purged` (`usageRows`). Exported for tests.
   */
  async purgeUsage(organisationId: string): Promise<number> {
    const ctx = { organisationId, workspaceId: null, userId: '', role: '', actorType: 'worker' as const };
    return this.tenantContext.runInTenantContext(ctx, async (m) => {
      const [row] = await m.query<Array<{ n: number }>>(`SELECT core.ai_usage_purge_expired(make_interval(days => $1)) AS n`, [AI_USAGE_RETENTION_DAYS]);
      const n = Number(row?.n ?? 0);
      if (n > 0) {
        await this.audit.record(m, { organisationId, userId: '' }, AuditAction.AI_RETENTION_PURGED, {
          actorUserId: null,
          entityType: 'ai_usage',
          metadata: { conversations: 0, usageRows: n, retentionDays: AI_USAGE_RETENTION_DAYS },
        });
      }
      return n;
    });
  }
}
