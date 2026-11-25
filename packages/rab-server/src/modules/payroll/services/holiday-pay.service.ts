import { assertSafePence, PermissionFlag, rolledUpHolidayPayPence } from '@rab/shared';
import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import { AuditAction, AuditService } from '../../../engine/core-modules/audit/audit.service';
import { StepUpReauthService } from '../../../engine/core-modules/auth/services/step-up-reauth.service';
import { PermissionsService } from '../../../engine/core-modules/permissions/permissions.service';
import { ResourceScopeService } from '../../../engine/core-modules/resource-scope/resource-scope.service';
import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { businessTables } from '../../../engine/core-modules/tenant/business-tables';
import { TenantContextService } from '../../../engine/core-modules/tenant/tenant-context.service';

/** Owner decision 4: rolled-up at a rate (default 12.07%), or "our payroll provider handles holiday pay" (no line). */
export type HolidayPayMode = 'rolled_up' | 'provider';

/** Step-up action recorded on a refusal (STEP_UP_ACTIONS): changing how holiday pay is paid changes every later approval. */
export const HOLIDAY_PAY_UPDATE_STEP_UP = 'payroll.holiday_pay.update' as const;

/** Sanity bounds of a configured rate, in basis points (CHECK: 1..10000). 12.07% = 1207. */
export const HOLIDAY_RATE_MIN_BPS = 1;
export const HOLIDAY_RATE_MAX_BPS = 10_000;

export interface HolidayPaySettingView {
  mode: HolidayPayMode;
  /** Basis points (1207 = 12.07%); null when the provider handles holiday pay. */
  rateBps: number | null;
  /**
   * No row stored yet. FAIL-SAFE (review fix 3, owner decision 78's recommendation): behave as "our payroll provider
   * handles holiday pay" (no line) until the Initial Manager explicitly chooses rolled-up.
   */
  isDefault: boolean;
  updatedAt: string | null;
  updatedByName: string | null;
  /** Display hint: the caller may change it (payroll.calculate + current Initial Manager); the change re-checks all of it. */
  canManage: boolean;
}

/** One record's frozen holiday pay (taken at approval). Money is integer pence. */
export interface RecordHolidayPay {
  mode: HolidayPayMode;
  rateBps: number | null;
  basePence: number;
  holidayPayPence: number;
}

/**
 * Holiday pay (owner decision 4, assumption A3). Five layers for the setting: PermissionGuard (payroll.view to read,
 * payroll.calculate to change) -> here: the same flags, never a Venue Manager, the change only by the organisation's
 * CURRENT Initial Manager (the same authority as the agency calendar) with a recent step-up -> every query pinned to the
 * session's organisation -> RLS tenant -> RLS Initial-Manager predicate. The per-record snapshot is written in the
 * approval transaction by a workspace payroll manager and never changed (insert-only table, rounding re-checked by a CHECK).
 */
@Injectable()
export class HolidayPayService {
  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly permissions: PermissionsService,
    private readonly resourceScope: ResourceScopeService,
    private readonly audit: AuditService,
    private readonly stepUp: StepUpReauthService,
  ) {}

  private async assertFlag(m: EntityManager, ctx: AuthContext, flag: typeof PermissionFlag.PAYROLL_VIEW | typeof PermissionFlag.PAYROLL_CALCULATE): Promise<void> {
    if (!(await this.permissions.userHasPermissionTx(m, ctx, flag))) throw new ForbiddenException('Permission required.');
    if ((await this.resourceScope.resolveTx(m, ctx)).kind === 'venue') throw new ForbiddenException('Permission required.');
  }

  private async isInitialManager(m: EntityManager, ctx: AuthContext): Promise<boolean> {
    const rows = await m.query(
      `SELECT 1 FROM core.manager_profile WHERE user_id = $1 AND organisation_id = $2 AND type = 'internal' AND is_initial_manager AND superseded_at IS NULL`,
      [ctx.userId, ctx.organisationId],
    );
    return rows.length > 0;
  }

  async getSetting(ctx: AuthContext): Promise<HolidayPaySettingView> {
    return this.tenantContext.runInTenantContext(ctx, async (m) => {
      await this.assertFlag(m, ctx, PermissionFlag.PAYROLL_VIEW);
      const canManage = (await this.permissions.userHasPermissionTx(m, ctx, PermissionFlag.PAYROLL_CALCULATE)) && (await this.isInitialManager(m, ctx));
      return { ...(await this.view(m, ctx)), canManage };
    });
  }

  /** Rolled-up holiday pay at `rateBps` (decision 4 default 1207 = 12.07%) for every record approved from now on. */
  async useRolledUpRate(ctx: AuthContext, rateBps: number): Promise<HolidayPaySettingView> {
    if (!Number.isInteger(rateBps) || rateBps < HOLIDAY_RATE_MIN_BPS || rateBps > HOLIDAY_RATE_MAX_BPS) {
      throw new BadRequestException(`The holiday pay rate must be a whole number of basis points between ${HOLIDAY_RATE_MIN_BPS} and ${HOLIDAY_RATE_MAX_BPS}.`);
    }
    return this.change(ctx, 'rolled_up', rateBps);
  }

  /** "Our payroll provider handles holiday pay": no holiday line on records approved from now on. */
  async useProvider(ctx: AuthContext): Promise<HolidayPaySettingView> {
    return this.change(ctx, 'provider', null);
  }

  private async change(ctx: AuthContext, mode: HolidayPayMode, rateBps: number | null): Promise<HolidayPaySettingView> {
    // Decision 5's action-bound proof first (enrolled authenticator + a single-use proof made for this action, Lane P1),
    // before any read and outside our transaction (its refusal is audited in a short transaction of its own), then the
    // flag / Venue Manager / Initial Manager checks under the write.
    await this.stepUp.assertFreshSecondFactorForAction(ctx, HOLIDAY_PAY_UPDATE_STEP_UP);
    return this.tenantContext.runInTenantContext(ctx, async (m) => {
      await this.assertCanManage(m, ctx);
      const before = await this.view(m, ctx);
      await m.query(
        `INSERT INTO core.organisation_payroll_setting (organisation_id, holiday_pay_mode, holiday_pay_rate_bps, updated_by)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (organisation_id) DO UPDATE SET holiday_pay_mode = EXCLUDED.holiday_pay_mode,
           holiday_pay_rate_bps = EXCLUDED.holiday_pay_rate_bps, updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [ctx.organisationId, mode, rateBps, ctx.userId],
      );
      await this.audit.record(m, ctx, AuditAction.PAYROLL_HOLIDAY_PAY_SETTING_CHANGED, {
        entityType: 'organisation_payroll_setting', entityId: ctx.organisationId!,
        metadata: { before: { mode: before.mode, rateBps: before.rateBps, isDefault: before.isDefault }, after: { mode, rateBps } },
      });
      return { ...(await this.view(m, ctx)), canManage: true };
    });
  }

  private async assertCanManage(m: EntityManager, ctx: AuthContext): Promise<void> {
    await this.assertFlag(m, ctx, PermissionFlag.PAYROLL_CALCULATE);
    if (!(await this.isInitialManager(m, ctx))) throw new ForbiddenException('Only the Initial Manager can change how holiday pay is paid.');
  }

  private async view(m: EntityManager, ctx: AuthContext): Promise<Omit<HolidayPaySettingView, 'canManage'>> {
    const [row] = await m.query(
      `SELECT s.holiday_pay_mode, s.holiday_pay_rate_bps, s.updated_at,
              (SELECT u.first_name || ' ' || u.last_name FROM core."user" u WHERE u.id = s.updated_by) AS updated_by_name
         FROM core.organisation_payroll_setting s WHERE s.organisation_id = $1`,
      [ctx.organisationId],
    );
    if (!row) return { mode: 'provider', rateBps: null, isDefault: true, updatedAt: null, updatedByName: null };
    return {
      mode: row.holiday_pay_mode, rateBps: row.holiday_pay_rate_bps === null ? null : Number(row.holiday_pay_rate_bps), isDefault: false,
      updatedAt: new Date(row.updated_at).toISOString(), updatedByName: row.updated_by_name ?? null,
    };
  }

  // ------------------------------------------------------------------------------------- hooks (caller's transaction)

  /**
   * Freezes the holiday pay of payroll records (same transaction, same workspace): the organisation's setting at this
   * moment, applied to each record's approved gross with rolledUpHolidayPayPence (nearest penny, half up, per record).
   *  - `approval`: records the caller has JUST approved. Always frozen: rolled-up only when the organisation has
   *    explicitly chosen it, otherwise a zero "provider" line (no row = provider, fail-safe), so a later opt-in never
   *    reprices them.
   *  - `backfill` (run prepare, records approved before holiday pay shipped): ONLY when the organisation has an explicit
   *    rolled-up setting; otherwise nothing is written and no line appears (review fix 3).
   * A record already frozen keeps its figure forever (filtered out first). The insert is plain: any conflict or refusal
   * (a finalised run's record, review fix 2) throws, never silently skipped (review fix 4b).
   */
  async snapshotRecords(m: EntityManager, ctx: AuthContext, recordIds: readonly string[], purpose: 'approval' | 'backfill'): Promise<number> {
    if (!recordIds.length) return 0;
    const t = businessTables(m);
    const setting = await this.view(m, ctx);
    if (purpose === 'backfill' && !(setting.mode === 'rolled_up' && !setting.isDefault)) return 0;
    const records: Array<{ id: string; staff_profile_id: string; amount_pence: string; staff_user_id: string }> = await m.query(
      `SELECT pr.id, pr.staff_profile_id, pr.amount_pence, sp.user_id AS staff_user_id
         FROM ${t.payroll_record} pr JOIN ${t.staff_profile} sp ON sp.id = pr.staff_profile_id
        WHERE pr.id = ANY($1::uuid[]) AND pr.organisation_id = $2 AND pr.workspace_id = $3 AND pr.status IN ('approved', 'processing', 'paid')
          AND NOT EXISTS (SELECT 1 FROM core.payroll_record_holiday_pay h
                           WHERE h.payroll_record_id = pr.id AND h.organisation_id = $2 AND h.workspace_id = $3)`,
      [[...recordIds], ctx.organisationId, ctx.workspaceId],
    );
    for (const r of records) {
      const base = assertSafePence(Number(r.amount_pence), 'payroll_record.amount_pence');
      const holiday = setting.mode === 'rolled_up' ? rolledUpHolidayPayPence(base, setting.rateBps!) : 0;
      await m.query(
        `INSERT INTO core.payroll_record_holiday_pay (organisation_id, workspace_id, payroll_record_id, staff_profile_id, staff_user_id, mode, rate_bps, base_pence, holiday_pay_pence, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [ctx.organisationId, ctx.workspaceId, r.id, r.staff_profile_id, r.staff_user_id, setting.mode, setting.mode === 'rolled_up' ? setting.rateBps : null, base, holiday, ctx.userId],
      );
    }
    return records.length;
  }

  /** The frozen holiday pay of records (RLS: managers of the workspace, the record's own staff member, or the Worker). */
  async forRecords(m: EntityManager, ctx: Pick<AuthContext, 'organisationId' | 'workspaceId'>, recordIds: readonly string[]): Promise<Map<string, RecordHolidayPay>> {
    if (!recordIds.length) return new Map();
    const rows: Array<{ payroll_record_id: string; mode: HolidayPayMode; rate_bps: number | null; base_pence: string; holiday_pay_pence: string }> = await m.query(
      `SELECT payroll_record_id, mode, rate_bps, base_pence, holiday_pay_pence FROM core.payroll_record_holiday_pay
        WHERE payroll_record_id = ANY($1::uuid[]) AND organisation_id = $2 AND workspace_id = $3`,
      [[...recordIds], ctx.organisationId, ctx.workspaceId],
    );
    return new Map(rows.map((r) => [r.payroll_record_id, toRecordHolidayPay(r)]));
  }
}

export function toRecordHolidayPay(r: { mode: HolidayPayMode; rate_bps: number | null; base_pence: string | number; holiday_pay_pence: string | number }): RecordHolidayPay {
  return {
    mode: r.mode, rateBps: r.rate_bps === null ? null : Number(r.rate_bps),
    basePence: assertSafePence(Number(r.base_pence), 'payroll_record_holiday_pay.base_pence'),
    holidayPayPence: assertSafePence(Number(r.holiday_pay_pence), 'payroll_record_holiday_pay.holiday_pay_pence'),
  };
}
