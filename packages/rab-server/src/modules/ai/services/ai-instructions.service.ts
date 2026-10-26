import { createHash } from 'node:crypto';

import {
  AI_INSTRUCTIONS_LIMITS,
  AI_INSTRUCTIONS_STEP_UP_ACTION,
  AiWorkspaceInstructionsDeleteRequest,
  AiWorkspaceInstructionsUpdateRequest,
  AiWorkspaceInstructionsView,
} from '@rab/shared';
import { HttpException, Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import { AuditAction, AuditService } from '../../../engine/core-modules/audit/audit.service';
import { StepUpReauthService } from '../../../engine/core-modules/auth/services/step-up-reauth.service';
import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { TenantContextService } from '../../../engine/core-modules/tenant/tenant-context.service';
import { AiInstructionsContentRefusedException, AiNotAvailableException, AiRecordNotFoundException } from '../exceptions/ai.exceptions';
import { AiSkillReasonRequiredException } from '../exceptions/ai-skill.exceptions';
import { checkInstructionContent } from '../skills/skill-content-rules';
import { returningRows } from './ai-query-rows';
import { AiSettingsAuthority } from './ai-settings-authority.service';

const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

interface InstructionRow {
  content: string;
  content_sha256: string;
  updated_at: Date;
}

/**
 * Settings → AI → Instructions (C1 / TWENTY_UI_CONTRACT_DELTAS CD-4, owner-approved TW-D5; security rule 5.3). The CEO's
 * organisation-wide text, placed AFTER the fixed system prompt under `AI_INSTRUCTIONS_PROMPT_HEADER` (prompt/system-prompt.ts),
 * scanned with the rest of the outgoing payload (EX-1), and it can never change the tool set.
 *
 * Five layers: (1) controller JwtAuthGuard + @ManagerApplication + PermissionGuard(ai.settings); (2) here, through
 * `AiSettingsAuthority` (the same checks and order as the skills and model settings: Inspect refused, `ai.settings`
 * re-read from PostgreSQL, the CEO, both AI switches), re-run inside every write transaction; (3) organisation-scoped
 * queries; (4) FORCE RLS on `core.organisation_ai_instruction` (read: the organisation AND `ai_actor_eligible()`);
 * (5) writes need `core.ai_settings_writer()` and `updated_by = current_uid()` in RLS, and `content_sha256` must equal
 * the content's SHA-256 (CHECK). Writes need a recent step-up (`organisation.ai.instructions.update`) and a reason, run
 * the Phase 4 content rules (`checkInstructionContent`: codes only, never the text), and are audited
 * `ai.instructions_updated` with length and hashes only.
 */
@Injectable()
export class AiInstructionsService {
  constructor(
    private readonly authority: AiSettingsAuthority,
    private readonly stepUp: StepUpReauthService,
    private readonly audit: AuditService,
    private readonly tenantContext: TenantContextService,
  ) {}

  async get(ctx: AuthContext): Promise<AiWorkspaceInstructionsView> {
    return this.tenantContext.runInTenantContext(this.bound(ctx), async (m) => {
      await this.authority.assertSettingsWriterTx(m, ctx);
      return toView(await this.row(m, ctx.organisationId!));
    });
  }

  async update(ctx: AuthContext, input: AiWorkspaceInstructionsUpdateRequest): Promise<AiWorkspaceInstructionsView> {
    await this.authorizeWrite(ctx, input?.reason);
    const refusals = checkInstructionContent(input?.content);
    if (refusals.length > 0) throw new AiInstructionsContentRefusedException(refusals);
    const content = input.content;
    const hash = sha256(content);
    return this.writeTx(ctx, async (m, organisationId) => {
      const before = await this.row(m, organisationId, true);
      await m.query(
        `INSERT INTO core.organisation_ai_instruction (organisation_id, content, content_sha256, updated_by, reason) VALUES ($1, $2, $3, core.current_uid(), $4)
         ON CONFLICT (organisation_id) DO UPDATE SET content = EXCLUDED.content, content_sha256 = EXCLUDED.content_sha256, updated_by = EXCLUDED.updated_by,
           reason = EXCLUDED.reason, updated_at = now()`,
        [organisationId, content, hash, input.reason],
      );
      await this.audit.record(m, ctx, AuditAction.AI_INSTRUCTIONS_UPDATED, {
        entityType: 'organisation',
        entityId: organisationId,
        metadata: { contentLength: content.length, contentSha256: hash, previousContentSha256: before?.content_sha256 ?? null, cleared: false, reason: input.reason },
      });
    });
  }

  /** "Clear instructions": removes the row (no row = none). Nothing to clear is a 404, never a silent success. */
  async clear(ctx: AuthContext, input: AiWorkspaceInstructionsDeleteRequest): Promise<AiWorkspaceInstructionsView> {
    await this.authorizeWrite(ctx, input?.reason);
    return this.writeTx(ctx, async (m, organisationId) => {
      const removed = await returningRows<{ content_sha256: string }>(
        m,
        `DELETE FROM core.organisation_ai_instruction WHERE organisation_id = $1 RETURNING content_sha256`,
        [organisationId],
      );
      if (removed.length === 0) throw new AiRecordNotFoundException();
      await this.audit.record(m, ctx, AuditAction.AI_INSTRUCTIONS_UPDATED, {
        entityType: 'organisation',
        entityId: organisationId,
        metadata: { contentLength: 0, contentSha256: null, previousContentSha256: removed[0]!.content_sha256, cleared: true, reason: input.reason },
      });
    });
  }

  /** Authorisation first (a stranger learns nothing and is not asked to step up), then the step-up, then the reason. */
  private async authorizeWrite(ctx: AuthContext, reason: unknown): Promise<void> {
    await this.tenantContext.runInTenantContext(this.bound(ctx), (m) => this.authority.assertSettingsWriterTx(m, ctx));
    await this.stepUp.assertRecentStepUp(ctx, AI_INSTRUCTIONS_STEP_UP_ACTION);
    if (typeof reason !== 'string' || reason.trim().length < AI_INSTRUCTIONS_LIMITS.reasonMinChars || reason.length > AI_INSTRUCTIONS_LIMITS.reasonMaxChars) {
      throw new AiSkillReasonRequiredException();
    }
  }

  /** The write transaction: authorisation re-checked inside it, the write and its audit row, then the fresh view. */
  private async writeTx(ctx: AuthContext, write: (m: EntityManager, organisationId: string) => Promise<void>): Promise<AiWorkspaceInstructionsView> {
    try {
      return await this.tenantContext.runInTenantContext(this.bound(ctx), async (m) => {
        await this.authority.assertSettingsWriterTx(m, ctx);
        await write(m, ctx.organisationId!);
        return toView(await this.row(m, ctx.organisationId!));
      });
    } catch (error) {
      if (error instanceof HttpException) throw error;
      const code = (error as { driverError?: { code?: string } })?.driverError?.code ?? (error as { code?: string })?.code;
      // The DB CHECK is the second net behind the content rules; RLS refusing a write the service let through is a 404.
      if (code === '23514') throw new AiInstructionsContentRefusedException(['length']);
      if (code === '42501') throw new AiRecordNotFoundException();
      throw error;
    }
  }

  private async row(m: EntityManager, organisationId: string, forUpdate = false): Promise<InstructionRow | null> {
    const [row] = await m.query<InstructionRow[]>(
      `SELECT content, content_sha256, updated_at FROM core.organisation_ai_instruction WHERE organisation_id = $1${forUpdate ? ' FOR UPDATE' : ''}`,
      [organisationId],
    );
    return row ?? null;
  }

  private bound(ctx: AuthContext): AuthContext {
    if (!ctx || ctx.inspectedBy || !ctx.organisationId) throw new AiNotAvailableException();
    return { ...ctx, role: '' };
  }
}

function toView(row: InstructionRow | null): AiWorkspaceInstructionsView {
  return {
    content: row?.content ?? null,
    contentLength: row?.content.length ?? 0,
    contentSha256: row?.content_sha256 ?? null,
    updatedAt: row ? new Date(row.updated_at).toISOString() : null,
    limits: AI_INSTRUCTIONS_LIMITS,
  };
}
