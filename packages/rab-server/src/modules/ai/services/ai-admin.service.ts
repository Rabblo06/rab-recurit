import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import { AuditAction, AuditService } from '../../../engine/core-modules/audit/audit.service';
import { StepUpReauthService } from '../../../engine/core-modules/auth/services/step-up-reauth.service';
import { PlatformAdminService } from '../../../engine/core-modules/platform-admin/platform-admin.service';
import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { TenantContextService } from '../../../engine/core-modules/tenant/tenant-context.service';
import { AI_HISTORY_MAX_MESSAGES, AI_MAX_MESSAGES_PER_CONVERSATION, AI_MAX_STORED_CONTENT_CHARS, AI_TOOL_MAX_ROWS } from '../constants/ai.constants';
import { AiToolRegistry } from '../tools/ai-tool-registry.service';
import { AiConfigService } from './ai-config.service';
import { AiTurnQueueService } from './ai-turn-queue.service';
import { AiAdminUsageRow, AiUsageService } from './ai-usage.service';

export type AiAdminActor = Pick<AuthContext, 'userId' | 'organisationId' | 'workspaceId' | 'sessionId' | 'inspectedBy'>;

export interface AiOrganisationSettingView {
  organisationId: string;
  enabled: boolean;
  updatedAt: string | null;
}

/**
 * Platform-administrator AI controls and METADATA (docs/ai/API_CONTRACT.md §Admin). Never returns a conversation, a
 * message, a prompt, a tool result or the provider key — only switches, configuration facts, queue counts and usage
 * counters. Layers: `PlatformAdminGuard` on the controller → this service re-checks `core.is_active_platform_admin`
 * (layer 2) → the organisation switch write runs bound to the TARGET organisation, where the RLS WITH CHECK again
 * requires an active platform administrator (layers 3–5); the usage read is `core.ai_admin_usage_summary` (42501 for
 * anyone else, counts only). Admin Inspect is refused for every write; turning a switch requires a recent step-up.
 */
@Injectable()
export class AiAdminService {
  constructor(
    private readonly config: AiConfigService,
    private readonly usage: AiUsageService,
    private readonly queue: AiTurnQueueService,
    private readonly registry: AiToolRegistry,
    private readonly platformAdmin: PlatformAdminService,
    private readonly stepUp: StepUpReauthService,
    private readonly audit: AuditService,
    private readonly tenantContext: TenantContextService,
  ) {}

  /** Configuration + health metadata for the Admin Panel's Health/Config tabs. */
  async overview(actor: AiAdminActor) {
    await this.assertAdmin(actor);
    const queue = await this.queue.counts().catch(() => null);
    return {
      platformEnabled: this.config.enabled,
      provider: this.config.provider,
      model: this.config.model,
      modelAllowlisted: this.config.modelAllowlisted,
      credentialsConfigured: this.config.credentialsConfigured,
      externalProvider: Boolean(this.config.provider && this.config.provider !== 'mock'),
      telemetry: 'disabled',
      limits: {
        maxOutputTokens: this.config.maxOutputTokens,
        maxSteps: this.config.maxSteps,
        maxInputChars: this.config.maxInputChars,
        orgDailyTokenBudget: this.config.orgDailyTokenBudget,
        turnTokenReservation: this.config.turnTokenReservation,
        userRatePerMinute: this.config.userRatePerMinute,
        orgMaxActiveTurns: this.config.orgMaxActiveTurns,
        turnTimeoutSeconds: this.config.turnTimeoutMs / 1000,
        historyMessages: AI_HISTORY_MAX_MESSAGES,
        messagesPerConversation: AI_MAX_MESSAGES_PER_CONVERSATION,
        storedCharsPerMessage: AI_MAX_STORED_CONTENT_CHARS,
        toolRows: AI_TOOL_MAX_ROWS,
      },
      retention: { days: this.config.retentionDays, mode: this.config.retentionMode, intervalMinutes: this.config.retentionIntervalMinutes },
      queue: queue ? { name: 'rab-ai', available: true, ...queue } : { name: 'rab-ai', available: false },
      tools: this.registry.catalogue(),
    };
  }

  /** Per-organisation usage counters for [from, to] (UTC days, ≤ 93), organisations with AI on or usage only. */
  async usageSummary(actor: AiAdminActor, from: string, to: string, limit: number): Promise<{ from: string; to: string; organisations: AiAdminUsageRow[] }> {
    await this.assertAdmin(actor);
    const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;
    // Same bound the database function enforces (≤ 93 days), answered as a 400 rather than a database error.
    if (!Number.isFinite(days) || days < 0 || days > 92) throw new BadRequestException('The usage range must be 1 to 93 days.');
    const ctx = { organisationId: actor.organisationId, workspaceId: null, userId: actor.userId, role: '' };
    const organisations = await this.tenantContext.runInTenantContext(ctx, (m) => this.usage.adminSummary(m, from, to, limit));
    return { from, to, organisations };
  }

  async getOrganisationSetting(actor: AiAdminActor, organisationId: string): Promise<AiOrganisationSettingView> {
    return this.inTarget(actor, organisationId, false, (m) => this.readSetting(m, organisationId));
  }

  /** Turns one organisation's AI switch on or off (audited in the TARGET organisation's trail, `via: platform_admin`). */
  async setOrganisationSetting(actor: AiAdminActor, organisationId: string, enabled: boolean, reason?: string): Promise<AiOrganisationSettingView> {
    if (actor.inspectedBy) throw new ForbiddenException('This action is unavailable while inspecting another user.');
    await this.assertAdmin(actor);
    await this.stepUp.assertRecentStepUp({ organisationId: actor.organisationId, workspaceId: actor.workspaceId, userId: actor.userId, sessionId: actor.sessionId });
    return this.inTarget(actor, organisationId, true, async (m, ctx) => {
      const before = await this.readSetting(m, organisationId);
      await m.query(
        `INSERT INTO core.organisation_ai_setting (organisation_id, enabled, updated_by, reason) VALUES ($1, $2, $3, $4)
         ON CONFLICT (organisation_id) DO UPDATE SET enabled = EXCLUDED.enabled, updated_by = EXCLUDED.updated_by, reason = EXCLUDED.reason, updated_at = now()`,
        [organisationId, enabled, actor.userId, reason ?? null],
      );
      await this.audit.record(m, ctx, AuditAction.AI_ORGANISATION_SETTING_CHANGED, {
        entityType: 'organisation',
        entityId: organisationId,
        metadata: { enabled, previous: before.enabled, via: 'platform_admin', reason: reason ?? null },
      });
      return this.readSetting(m, organisationId);
    });
  }

  private async readSetting(m: EntityManager, organisationId: string): Promise<AiOrganisationSettingView> {
    const [row] = await m.query<Array<{ enabled: boolean; updated_at: Date }>>(`SELECT enabled, updated_at FROM core.organisation_ai_setting WHERE organisation_id = $1`, [organisationId]);
    return { organisationId, enabled: row?.enabled === true, updatedAt: row ? new Date(row.updated_at).toISOString() : null };
  }

  private async assertAdmin(actor: AiAdminActor): Promise<void> {
    if (!(await this.platformAdmin.isPlatformAdmin(actor))) throw new ForbiddenException('Only a platform administrator can do this.');
  }

  /** Platform-admin check + a transaction bound to the TARGET organisation + 404 for an unknown organisation. */
  private async inTarget<T>(actor: AiAdminActor, organisationId: string, mutation: boolean, fn: (m: EntityManager, ctx: Pick<AuthContext, 'organisationId' | 'userId' | 'inspectedBy'>) => Promise<T>): Promise<T> {
    if (mutation && actor.inspectedBy) throw new ForbiddenException('This action is unavailable while inspecting another user.');
    const ctx = { organisationId, workspaceId: null, userId: actor.userId, role: '', inspectedBy: undefined };
    return this.tenantContext.runInTenantContext(ctx, async (m) => {
      if (!(await this.platformAdmin.isPlatformAdminTx(m, actor))) throw new ForbiddenException('Only a platform administrator can do this.');
      const [org] = await m.query(`SELECT id FROM core.organisation WHERE id = $1`, [organisationId]);
      if (!org) throw new NotFoundException('Organisation not found.');
      return fn(m, ctx);
    });
  }
}
