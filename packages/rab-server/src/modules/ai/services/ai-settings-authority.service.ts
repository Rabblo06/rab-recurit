import { PermissionFlag } from '@rab/shared';
import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import { PermissionsService } from '../../../engine/core-modules/permissions/permissions.service';
import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { AiNotAvailableException } from '../exceptions/ai.exceptions';
import { AiConfigService } from './ai-config.service';

/**
 * Layer 2 of Settings → AI → Skills (docs/ai/PHASE4_TWENTY_PLAN.md §2.6), in a file of its own so that
 * `ai-skill.service.ts` never imports `PermissionsService` (guarantee G1, static test T4-X1): this class answers ONE
 * yes/no question and returns nothing, so no skill code can obtain, build or influence a permission set or a tool set.
 *
 * The same checks, in the same order, as `AiModelSettingsService` (Phase 1, D6/D7), inside the caller's tenant
 * transaction:
 *   1. Admin Inspect → the uniform 404 (an inspecting admin never reads or writes organisation AI settings);
 *   2. `ai.settings` re-read from PostgreSQL (overrides, then roles visible under RLS) → the same 404 (Batch 3, S10);
 *   3. the bound user is the organisation's CEO (`core.ai_settings_writer()`), the platform kill switch and the
 *      organisation's AI switch → otherwise the SAME 404 (a custom role carrying `ai.settings` grants nothing to a
 *      non-CEO, and an outsider learns nothing about the configuration).
 * Every refusal throws (never a boolean a caller could forget to check).
 */
@Injectable()
export class AiSettingsAuthority {
  constructor(
    private readonly permissions: PermissionsService,
    private readonly config: AiConfigService,
  ) {}

  async assertSettingsWriterTx(m: EntityManager, ctx: AuthContext): Promise<void> {
    if (ctx.inspectedBy || !ctx.organisationId) throw new AiNotAvailableException();
    if (!(await this.permissions.userHasPermissionTx(m, ctx, PermissionFlag.AI_SETTINGS))) {
      // Batch 3 (S10): the uniform 404, like every other refusal here (a 403 would confirm the settings exist).
      throw new AiNotAvailableException();
    }
    const [row] = await m.query<Array<{ writer: boolean; enabled: boolean | null }>>(
      `SELECT core.ai_settings_writer() AS writer, (SELECT s.enabled FROM core.organisation_ai_setting s WHERE s.organisation_id = $1) AS enabled`,
      [ctx.organisationId],
    );
    if (row?.writer !== true || !this.config.enabled || row.enabled !== true) throw new AiNotAvailableException();
  }
}
