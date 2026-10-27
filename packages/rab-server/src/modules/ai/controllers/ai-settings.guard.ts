import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';

import { AuthenticatedRequest } from '../../../engine/core-modules/auth/guards/jwt-auth.guard';
import { TenantContextService } from '../../../engine/core-modules/tenant/tenant-context.service';
import { AiNotAvailableException } from '../exceptions/ai.exceptions';
import { AiSettingsAuthority } from '../services/ai-settings-authority.service';

/**
 * Layer 1 of EVERY `/rest/v1/ai/settings…` route (overview, tools, prompt preview, models, model policy, assistant,
 * instructions, usage, skills), declarative, after JwtAuthGuard. ONE guard for all of them.
 * Batch 3 (S10, then every settings route, coordinator decisions 2026-10-26, as AiDecidableGuard / AiAgentsSwitchGuard):
 * the FULL settings gate —
 * Admin Inspect, `ai.settings` re-read from PostgreSQL (never the JWT), the CEO predicate, the platform and organisation
 * AI switches — and EVERY refusal is the same 404 AI_NOT_AVAILABLE. A PermissionGuard 403 for "no ai.settings" would
 * tell a manager the page exists. Every settings service re-runs the same gate inside its own transaction (layer 2), with
 * the same 404.
 */
@Injectable()
export class AiSettingsGuard implements CanActivate {
  constructor(
    private readonly authority: AiSettingsAuthority,
    private readonly tenantContext: TenantContextService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const ctx = context.switchToHttp().getRequest<AuthenticatedRequest>().authContext;
    if (!ctx || ctx.inspectedBy || !ctx.organisationId) throw new AiNotAvailableException();
    await this.tenantContext.runInTenantContext({ ...ctx, role: '' }, (m) => this.authority.assertSettingsWriterTx(m, ctx));
    return true;
  }
}
