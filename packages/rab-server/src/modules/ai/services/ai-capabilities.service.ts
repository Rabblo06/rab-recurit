import { AI_WRITE_TOOL_NAMES, AiCapabilitiesView, AiWriteToolName } from '@rab/shared';
import { Injectable } from '@nestjs/common';

import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { AiNotAvailableException } from '../exceptions/ai.exceptions';
import { AI_READ_TOOL_LABELS } from '../tools/ai-tool.constants';
import { AiToolRegistry } from '../tools/ai-tool-registry.service';
import { AiAccessService, AiActor } from './ai-access.service';
import { AiSkillService } from './ai-skill.service';

/**
 * S4: fixed server text for the write tools in "See what I can do". The model can only PROPOSE these (`propose_action`);
 * the label and summary say so, so the list never suggests the assistant changes anything by itself.
 */
export const AI_WRITE_TOOL_CAPABILITY_TEXT: Readonly<Record<string, { label: string; summary: string }>> = Object.freeze({
  create_draft_shift: { label: 'Suggest a draft shift', summary: 'Suggests a new DRAFT shift for you to approve. Nothing is created until you approve it in Crewflow.' },
  update_draft_shift: { label: 'Suggest changes to a draft shift', summary: 'Suggests changes to a DRAFT shift for you to approve. Nothing changes until you approve it in Crewflow.' },
  add_staff_note: { label: 'Suggest a staff note', summary: "Suggests a note for a staff member's profile for you to approve. Nothing is saved until you approve it in Crewflow." },
});

/**
 * `GET /rest/v1/ai/capabilities` (C1 CD-8, "See what I can do"; Batch 3 S4): what THIS caller can actually do, right now.
 *
 *   tools      — the read tools whose flag the caller holds (the registry's own `catalogueFor` — the SAME filter a turn
 *                uses for its catalogue; flags read from PostgreSQL in the caller's tenant context, never the JWT);
 *   writeTools — exactly the write tools the caller could PROPOSE (`permittedWriteTools`, the filter that decides
 *                `propose_action`), fixed approval-only labels; [] without a write flag. Nothing the caller lacks is listed.
 *   skills — the organisation's active skills readable by the caller (name / label / description, never content).
 *
 * Layers: controller `JwtAuthGuard` + `AiAvailableGuard` (ai.use, eligibility, switches, Inspect → uniform 404); this
 * service re-runs `assertAvailable` (layer 2) and refuses a context without a session; every read is in the caller's own
 * tenant context under RLS. No model is called and nothing is written.
 */
@Injectable()
export class AiCapabilitiesService {
  constructor(
    private readonly access: AiAccessService,
    private readonly registry: AiToolRegistry,
    private readonly skills: AiSkillService,
  ) {}

  async view(ctx: AuthContext): Promise<AiCapabilitiesView> {
    await this.access.assertAvailable(ctx);
    if (ctx.inspectedBy || !ctx.organisationId || !ctx.workspaceId || !ctx.sessionId) throw new AiNotAvailableException();
    const actor = { organisationId: ctx.organisationId, workspaceId: ctx.workspaceId, userId: ctx.userId, sessionId: ctx.sessionId } as AiActor;
    const held = (await this.registry.sessionChecker(actor)).permissions();
    const reads = this.registry.catalogueFor(held).map((l) => ({ name: l.name, label: AI_READ_TOOL_LABELS[l.name] ?? l.name, summary: l.summary }));
    // Agent 9 decision: `tools` = read tools only; `writeTools` = exactly the write tools the caller may PROPOSE.
    const writeTools = [...this.registry.permittedWriteTools(held)]
      .filter((name): name is AiWriteToolName => (AI_WRITE_TOOL_NAMES as readonly string[]).includes(name) && !!AI_WRITE_TOOL_CAPABILITY_TEXT[name])
      .map((name) => ({ name, ...AI_WRITE_TOOL_CAPABILITY_TEXT[name]! }));
    return { tools: reads, writeTools, skills: await this.skills.summariesFor(actor) };
  }
}
