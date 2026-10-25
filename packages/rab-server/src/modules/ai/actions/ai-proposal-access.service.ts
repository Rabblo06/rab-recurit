import { AiUnavailableReason, PermissionFlag } from '@rab/shared';
import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import { PermissionsService } from '../../../engine/core-modules/permissions/permissions.service';
import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { AiNotAvailableException } from '../exceptions/ai.exceptions';
import { AiAccessService } from '../services/ai-access.service';
import { AiConfigService } from '../services/ai-config.service';

/**
 * Who may see and decide AI proposals (PHASE5_TWENTY_PLAN §2.4 step 1, D9). The Phase 1 evaluation order applies up to
 * and including the organisation switch — not an Admin Inspect session, `ai.use`, a workspace, CEO / current Initial
 * Manager, the platform kill switch, the organisation switch — and anything that fails there is the uniform 404
 * `AI_NOT_AVAILABLE`. Unlike a chat turn, deciding a proposal calls no model, so "no model is ready" (503
 * AI_NOT_CONFIGURED) and "real provider on non-synthetic data" (403, EX-1) do NOT block a decision (D9).
 *
 * `assertDecidable` runs once per request (layer 2); `assertDecidableTx` re-reads the same facts inside the decision's own
 * transaction (one snapshot with the compare-and-set), from PostgreSQL — never the request's cached permission set.
 */
@Injectable()
export class AiProposalAccessService {
  constructor(
    private readonly access: AiAccessService,
    private readonly config: AiConfigService,
    private readonly permissions: PermissionsService,
  ) {}

  async assertDecidable(ctx: AuthContext): Promise<void> {
    const state = await this.access.evaluate(ctx);
    if (state.available) return;
    if (state.reason === AiUnavailableReason.NOT_CONFIGURED || state.reason === AiUnavailableReason.DEMO_DATA_ONLY) return;
    throw new AiNotAvailableException();
  }

  async assertDecidableTx(m: EntityManager, ctx: AuthContext): Promise<void> {
    if (ctx.inspectedBy || !ctx.organisationId || !ctx.workspaceId) throw new AiNotAvailableException();
    if (!this.config.enabled) throw new AiNotAvailableException();
    if (!(await this.permissions.userHasPermissionTx(m, ctx, PermissionFlag.AI_USE))) throw new AiNotAvailableException();
    const [row] = (await m.query(
      `SELECT core.ai_actor_eligible() AS eligible,
              coalesce((SELECT s.enabled FROM core.organisation_ai_setting s WHERE s.organisation_id = $1), false) AS enabled`,
      [ctx.organisationId],
    )) as Array<{ eligible: boolean; enabled: boolean }>;
    if (row?.eligible !== true || row?.enabled !== true) throw new AiNotAvailableException();
  }
}
