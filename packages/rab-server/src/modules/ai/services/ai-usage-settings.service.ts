import { AiUsageDailyPoint, AiUsageTotals, AiUsageView, PermissionFlag } from '@rab/shared';
import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import { AuditAction, AuditService } from '../../../engine/core-modules/audit/audit.service';
import { PermissionsService } from '../../../engine/core-modules/permissions/permissions.service';
import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { TenantContextService } from '../../../engine/core-modules/tenant/tenant-context.service';
import { AiUsagePeriod } from '../dto/ai-usage-query.dto';
import { AiNotAvailableException, AiQuotaUnavailableError, AiServiceUnavailableException } from '../exceptions/ai.exceptions';
import { AiConfigService } from './ai-config.service';
import { AiCostMeterService } from './ai-cost-meter.service';
import { AiQuotaService, utcDay } from './ai-quota.service';

interface TotalsRow {
  turns: string | number;
  input_tokens: string;
  cached_input_tokens: string;
  cache_write_tokens: string;
  output_tokens: string;
  cost_usd_micros: string;
}

const TOTALS = `count(*)::bigint AS turns, coalesce(sum(u.input_tokens), 0)::text AS input_tokens,
  coalesce(sum(u.cached_input_tokens), 0)::text AS cached_input_tokens, coalesce(sum(u.cache_write_tokens), 0)::text AS cache_write_tokens,
  coalesce(sum(u.output_tokens), 0)::text AS output_tokens, coalesce(sum(u.cost_usd_micros), 0)::text AS cost_usd_micros`;

function totals(r: TotalsRow | undefined): AiUsageTotals {
  return {
    turns: Number(r?.turns ?? 0),
    inputTokens: Number(r?.input_tokens ?? 0),
    cachedInputTokens: Number(r?.cached_input_tokens ?? 0),
    cacheWriteTokens: Number(r?.cache_write_tokens ?? 0),
    outputTokens: Number(r?.output_tokens ?? 0),
    costUsdMicros: Number(r?.cost_usd_micros ?? 0),
  };
}

/** `[from, to]` (UTC days, inclusive): today, or the current UTC month up to today (≤ 31 days). */
export function usagePeriodRange(period: AiUsagePeriod, now: Date = new Date()): { from: string; to: string } {
  const to = utcDay(now);
  if (period === 'today') return { from: to, to };
  return { from: `${to.slice(0, 8)}01`, to };
}

/** S8: the series length (owner's "Last 14 days" chart). */
export const AI_USAGE_DAILY_DAYS = 14;

/** S8: the last `days` UTC days including today, oldest first ('YYYY-MM-DD'). */
export function usageDailyDays(now: Date = new Date(), days = AI_USAGE_DAILY_DAYS): string[] {
  const out: string[] = [];
  for (let i = days - 1; i >= 0; i--) out.push(utcDay(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - i))));
  return out;
}

/** S8: zero-fills the ledger's per-day sums onto exactly the given days (a row outside them is ignored). Pure. */
export function zeroFilledDaily(days: readonly string[], rows: ReadonlyArray<{ day: string; turns: string | number; input_tokens: string; output_tokens: string; cost_usd_micros: string }>): AiUsageDailyPoint[] {
  const byDay = new Map(rows.map((r) => [r.day, r]));
  return days.map((day) => {
    const r = byDay.get(day);
    return { day, turns: Number(r?.turns ?? 0), inputTokens: Number(r?.input_tokens ?? 0), outputTokens: Number(r?.output_tokens ?? 0), costUsdMicros: Number(r?.cost_usd_micros ?? 0) };
  });
}

/**
 * Settings → AI → Usage (PHASE7_TWENTY_PLAN §2.3; route table `AI_API_ROUTES`, phase 7). Returns exactly `AiUsageView`:
 * totals, by-user and by-model rows from the insert-only `core.ai_usage` ledger, the day's budgets, and today's live
 * meters (Redis). Metadata only — never a prompt, a reply, a tool argument or result. Per-user rows are monitoring data
 * about other people (D7-3; THREAT-MODEL entry "AI-P7-usage"), so every read is audited `ai.usage_viewed`.
 *
 * Five layers:
 *   1. controller: JwtAuthGuard + @ManagerApplication + PermissionGuard(ai.settings);
 *   2. this service: refuses Admin Inspect, re-reads `ai.settings` from the database (403 like the guard), then requires
 *      the bound user to be the organisation's CEO (`core.ai_settings_writer()`), the platform kill switch and the
 *      organisation's AI switch — anything else is the uniform 404;
 *   3. every query is scoped to the caller's organisation (`organisation_id = $1` from the session, never the client);
 *   4. RLS (FORCE) on `core.ai_usage`: the bound organisation only;
 *   5. the tighter SELECT predicate: own rows, or every row of the organisation only for its CEO — a custom role carrying
 *      the flag still sees only its own rows even if layer 2 were bypassed.
 * Redis unavailable ⇒ 503 (the live meters cannot be read; nothing is guessed).
 */
@Injectable()
export class AiUsageSettingsService {
  constructor(
    private readonly config: AiConfigService,
    private readonly meter: AiCostMeterService,
    private readonly quota: AiQuotaService,
    private readonly permissions: PermissionsService,
    private readonly audit: AuditService,
    private readonly tenantContext: TenantContextService,
  ) {}

  async view(ctx: AuthContext, period: AiUsagePeriod): Promise<AiUsageView> {
    if (ctx.inspectedBy || !ctx.organisationId) throw new AiNotAvailableException();
    const organisationId = ctx.organisationId;
    const bound: AuthContext = { ...ctx, role: '' };
    const { from, to } = usagePeriodRange(period);
    const today = utcDay();
    return this.tenantContext.runInTenantContext(bound, async (m) => {
      await this.authorizeTx(m, ctx);
      const [sum] = await m.query<TotalsRow[]>(
        `SELECT ${TOTALS} FROM core.ai_usage u WHERE u.organisation_id = $1 AND u.usage_date BETWEEN $2::date AND $3::date`,
        [organisationId, from, to],
      );
      const users = await m.query<Array<TotalsRow & { user_id: string; first_name: string | null; last_name: string | null; today_micros: string }>>(
        `SELECT u.user_id, p.first_name, p.last_name, ${TOTALS},
                coalesce(sum(u.cost_usd_micros) FILTER (WHERE u.usage_date = $4::date), 0)::text AS today_micros
           FROM core.ai_usage u
           LEFT JOIN core."user" p ON p.id = u.user_id AND p.organisation_id = u.organisation_id
          WHERE u.organisation_id = $1 AND u.usage_date BETWEEN $2::date AND $3::date
          GROUP BY u.user_id, p.first_name, p.last_name
          ORDER BY sum(u.cost_usd_micros) DESC, u.user_id`,
        [organisationId, from, to, today],
      );
      const models = await m.query<Array<TotalsRow & { model: string }>>(
        `SELECT u.model, ${TOTALS} FROM core.ai_usage u
          WHERE u.organisation_id = $1 AND u.usage_date BETWEEN $2::date AND $3::date
          GROUP BY u.model ORDER BY sum(u.cost_usd_micros) DESC, u.model`,
        [organisationId, from, to],
      );
      // S8: the organisation's last 14 UTC days (zero-filled), from the same ledger under the same CEO-only layers; sums
      // only — no user id, name or per-user figure. `turns` counts ledger rows exactly as `totals.turns` does.
      const days = usageDailyDays();
      const dailyRows = await m.query<Array<{ day: string; turns: string; input_tokens: string; output_tokens: string; cost_usd_micros: string }>>(
        `SELECT to_char(u.usage_date, 'YYYY-MM-DD') AS day, count(*)::bigint AS turns, coalesce(sum(u.input_tokens), 0)::text AS input_tokens,
                coalesce(sum(u.output_tokens), 0)::text AS output_tokens, coalesce(sum(u.cost_usd_micros), 0)::text AS cost_usd_micros
           FROM core.ai_usage u
          WHERE u.organisation_id = $1 AND u.usage_date BETWEEN $2::date AND $3::date
          GROUP BY u.usage_date`,
        [organisationId, days[0], days[days.length - 1]],
      );
      const live = await this.liveMeters(m, organisationId, today);
      await this.audit.record(m, ctx, AuditAction.AI_USAGE_VIEWED, { entityType: 'organisation', entityId: organisationId, metadata: { period, from, to } });
      return {
        period,
        from,
        to,
        totals: totals(sum),
        byUser: users.map((r) => ({
          ...totals(r),
          userId: r.user_id,
          displayName: [r.first_name, r.last_name].filter((s): s is string => typeof s === 'string' && s.length > 0).join(' ') || 'Unknown user',
          userCostTodayMicros: Number(r.today_micros),
        })),
        byModel: models.map((r) => ({ ...totals(r), modelId: r.model, label: this.config.entry(r.model)?.label ?? r.model })),
        budgets: {
          orgDailyCostCeilingMicros: this.meter.orgCeilingMicros,
          userDailyCostCeilingMicros: this.meter.userCeilingMicros,
          orgDailyTokenBudget: this.config.orgDailyTokenBudget,
        },
        today: live,
        daily: zeroFilledDaily(days, dailyRows),
      };
    });
  }

  /** Today's organisation meters. A missing Redis key falls back to the persisted day (what a reservation would seed). */
  private async liveMeters(m: EntityManager, organisationId: string, day: string): Promise<AiUsageView['today']> {
    try {
      const [cost, tokens, alerts] = await Promise.all([this.meter.current(organisationId, day), this.quota.currentBudgetUse(organisationId, day), this.meter.alerts(organisationId, day)]);
      const [persisted] = await m.query<Array<{ cost: string; tokens: string }>>(
        `SELECT coalesce(sum(cost_usd_micros), 0)::text AS cost, coalesce(sum(input_tokens + output_tokens), 0)::text AS tokens
           FROM core.ai_usage_daily WHERE organisation_id = $1 AND usage_date = $2::date`,
        [organisationId, day],
      );
      return {
        orgCostMicros: cost ?? Number(persisted?.cost ?? 0),
        orgTokensUsedOrReserved: tokens ?? Number(persisted?.tokens ?? 0),
        alerts,
      };
    } catch (error) {
      if (error instanceof AiQuotaUnavailableError) throw new AiServiceUnavailableException();
      throw error;
    }
  }

  /** Layer 2 (mirrors AiModelSettingsService): Inspect refused, flag re-read (403), then CEO + both switches or the uniform 404. */
  private async authorizeTx(m: EntityManager, ctx: AuthContext): Promise<void> {
    if (ctx.inspectedBy) throw new AiNotAvailableException();
    if (!(await this.permissions.userHasPermissionTx(m, ctx, PermissionFlag.AI_SETTINGS))) {
      // Batch 3: the uniform 404, like every other refusal of the settings gate (a 403 would confirm the settings exist).
      throw new AiNotAvailableException();
    }
    const [row] = await m.query<Array<{ writer: boolean; enabled: boolean | null }>>(
      `SELECT core.ai_settings_writer() AS writer, (SELECT s.enabled FROM core.organisation_ai_setting s WHERE s.organisation_id = $1) AS enabled`,
      [ctx.organisationId],
    );
    if (row?.writer !== true || !this.config.enabled || row.enabled !== true) throw new AiNotAvailableException();
  }
}
