import { AI_PROMPT_SECTION_SEPARATOR, AiPromptPreviewView, AiPromptSectionView, PermissionFlagType } from '@rab/shared';
import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { asSchema, ToolSet } from 'ai';

import { providerApiKey } from '../../../engine/core-modules/ai/ai-readiness';
import { isRealProvider } from '../../../engine/core-modules/ai/models/catalog';
import { maxInputTokensFromBytes } from '../../../engine/core-modules/ai/models/cost';
import { AuditAction, AuditService } from '../../../engine/core-modules/audit/audit.service';
import { PermissionsService } from '../../../engine/core-modules/permissions/permissions.service';
import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { TenantContextService } from '../../../engine/core-modules/tenant/tenant-context.service';
import { AI_CHAT_TIER } from '../constants/ai.constants';
import { scanOutgoingPayload } from '../gateway/outgoing-payload-guard';
import { buildSystemPrompt, buildSystemPromptSections } from '../prompt/system-prompt';
import { AiActor } from './ai-access.service';
import { AiConfigService } from './ai-config.service';
import { AiSkillService } from './ai-skill.service';
import { boundSettingsContext, AiSettingsOverviewService } from './ai-settings-overview.service';
import { localToday } from '../prompt/local-today';
import { skillCatalogueLines } from '../skills/skill-catalogue';

/** A secret / token / personal-data shape was found in the preview: fixed code, never the matched text. */
export class AiPromptPreviewRefusedException extends HttpException {
  constructor() {
    super({ statusCode: 500, code: 'AI_PROMPT_PREVIEW_REFUSED', message: 'The prompt preview could not be shown.' }, HttpStatus.INTERNAL_SERVER_ERROR);
  }
}

const estimate = (text: string) => ({ estimate: Math.ceil(text.length / 4), upperBound: maxInputTokensFromBytes(Buffer.byteLength(text, 'utf8'), 0) });

/** Version of the fixed prompt text: a digest of the template with a fixed date, so it changes only when the code does. */
export function promptTemplateVersion(): string {
  // Small dependency-free FNV-1a digest (the value is a label, not a security control).
  let h = 0x811c9dc5;
  for (const ch of buildSystemPrompt('0000-00-00')) {
    h ^= ch.codePointAt(0)!;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `p1-${h.toString(16).padStart(8, '0')}`;
}

/**
 * `GET /ai/settings/prompt-preview` (Phase 8, D8-3, docs/ai/PHASE8_TWENTY_PLAN.md §2.1 "Prompt preview rules"): exactly the
 * FIXED PREFIX the next chat request would send for THIS caller — built server-side from the same functions the turn
 * runner and the gateway use:
 *   - `buildSystemPrompt(localToday(organisation timezone), { instructions })` — the runner's own call
 *     (ai-turn-runner.service.ts), with the organisation's workspace instructions read the same way (CD-4, p4 merge);
 *   - 3w: the catalogue of the caller's permitted read tools (every registered tool flag, read from PostgreSQL, as the
 *     runner's session checker reads them) and the fixed meta SDK tools (`sdkToolDefinitions`), never executed;
 * It contains no history, no tool results and no record rows of anyone, calls no model and has no "try it" (rule 10.5).
 *
 * Before returning, the whole text is scanned with `scanOutgoingPayload` with every configured provider key as a canary
 * (plus its JWT / bearer / long-token shapes): any hit is a 500 with a fixed code, never the text. The token figure is a
 * LOCAL estimate (chars/4 and the gateway's byte bound), never a provider count-tokens call. Each view is audited
 * `ai.prompt_previewed` (metadata only). Layers 1–5: as AiSettingsOverviewService (CEO + `ai.settings`, Inspect refused).
 */
@Injectable()
export class AiPromptPreviewService {
  private readonly logger = new Logger('AiPromptPreview');

  constructor(
    private readonly config: AiConfigService,
    private readonly permissions: PermissionsService,
    private readonly tenantContext: TenantContextService,
    private readonly audit: AuditService,
    private readonly settings: AiSettingsOverviewService,
    // 4w: the skill catalogue lines, read exactly as the runner reads them (the caller's own tenant context).
    private readonly skills: AiSkillService,
  ) {}

  async preview(ctx: AuthContext): Promise<AiPromptPreviewView> {
    const bound = boundSettingsContext(ctx);
    const facts = await this.tenantContext.runInTenantContext(bound, async (m) => {
      await this.settings.authorizeTx(m, ctx);
      const held = new Set<PermissionFlagType>();
      // 3w: exactly the flags the runner's session checker reads — every flag a registered tool needs (incl. staff.view).
      for (const flag of this.settings.toolFlags()) if (await this.permissions.userHasPermissionTx(m, ctx, flag)) held.add(flag);
      const [instruction] = await m.query<Array<{ content: string }>>(`SELECT content FROM core.organisation_ai_instruction WHERE organisation_id = $1`, [ctx.organisationId]);
      return { held, pins: await this.settings.readPins(m, ctx.organisationId!), timezone: await this.settings.readTimezone(m, ctx.organisationId!), instructions: instruction?.content ?? null };
    });

    const today = localToday(facts.timezone);
    // 3w: the permitted read tools are in the prompt as the catalogue; the model is offered only the fixed meta tools.
    const catalogue = this.settings.toolCatalogue(facts.held);
    const skillLines = await this.skills.catalogueFor({ organisationId: ctx.organisationId!, workspaceId: ctx.workspaceId!, userId: ctx.userId, sessionId: ctx.sessionId! } as AiActor);
    const systemPrompt = buildSystemPrompt(today, { instructions: facts.instructions, tools: catalogue, skills: skillLines });
    let sections: AiPromptSectionView[] | undefined;
    {
      // CD-5: Agent 9's builder with EXACTLY the context the turn runner's `buildSystemPrompt(today, { instructions })` uses
      // (no skill or tool lines are passed into the prompt on this server yet), so the sections ARE what the gateway sends.
      const built = buildSystemPromptSections({ today, timezone: '', instructions: facts.instructions, skills: skillLines, tools: catalogue }).filter((sct) => sct.text.length > 0);
      // The sections must BE the prompt the gateway sends (CD-5); a mismatch is a code defect: show none rather than a lie.
      if (built.map((sct) => sct.text).join(AI_PROMPT_SECTION_SEPARATOR) === systemPrompt) {
        sections = built.map((sct) => ({ key: sct.key, title: sct.title, text: sct.text, readOnly: true, tokenEstimate: estimate(sct.text) }));
      } else {
        this.logger.error('prompt sections do not join to the system prompt; sections omitted');
      }
    }
    const resolved = this.config.resolve(AI_CHAT_TIER, facts.pins);
    const tools = this.settings.offeredTools(facts.held);
    const toolCatalogue = catalogue.map((l) => ({ name: l.name, summary: l.summary }));
    const sdkDescriptions = Object.entries(tools).map(([name, t]) => ({ name, description: String((t as { description?: string }).description ?? '') }));
    const sdkTools = await Promise.all(Object.entries(tools).map(async ([name, t]) => ({ name, schemaBytes: await schemaBytes(t) })));

    // Secret scan of everything this response carries, with every configured provider key as an exact canary.
    const canaries = this.config.catalogue.filter(isRealProvider).map((entry) => providerApiKey(this.config.envFacts(), entry));
    const categories = scanOutgoingPayload({ system: systemPrompt, messages: [], extraTexts: [...toolCatalogue.flatMap((t) => [t.name, t.summary]), ...sdkDescriptions.flatMap((t) => [t.name, t.description])] }, { secrets: canaries });
    if (categories.length > 0) {
      // Categories only (never the text): a fixed prompt tripping the scan is a code defect to investigate.
      this.logger.error(`prompt preview refused: ${categories.join(',')}`);
      throw new AiPromptPreviewRefusedException();
    }

    const text = [systemPrompt, ...sdkDescriptions.map((t) => `${t.name}: ${t.description}`)].join('\n');
    const bytes = Buffer.byteLength(systemPrompt, 'utf8') + sdkTools.reduce((n, t) => n + t.schemaBytes + Buffer.byteLength(t.name, 'utf8'), 0) + sdkDescriptions.reduce((n, t) => n + Buffer.byteLength(t.description, 'utf8'), 0);
    const view: AiPromptPreviewView = {
      promptVersion: promptTemplateVersion(),
      tier: AI_CHAT_TIER,
      modelId: resolved?.model.id ?? null,
      systemPrompt,
      // S9: the skill lines exactly as the prompt's catalogue carries them (`- name: description`), from the ONE builder
      // the turn uses (`skillCatalogueLines`, inside `buildSystemPrompt`): each entry is byte-equal to a line sent.
      skillCatalogue: skillCatalogueLines(skillLines),
      toolCatalogue,
      sdkTools,
      tokenEstimate: { estimate: Math.ceil(text.length / 4), upperBound: maxInputTokensFromBytes(bytes) },
      // Phase 7 adds the per-model prompt-cache fact; production keeps caching off until the release checklist (D7-4).
      promptCache: 'none',
      generatedAt: new Date().toISOString(),
      ...(sections ? { sections, totalTokenEstimate: { estimate: sections.reduce((n, sct) => n + sct.tokenEstimate.estimate, 0), upperBound: sections.reduce((n, sct) => n + sct.tokenEstimate.upperBound, 0) } } : {}),
    };

    await this.tenantContext.runInTenantContext(bound, (m) =>
      this.audit.record(m, ctx, AuditAction.AI_PROMPT_PREVIEWED, {
        entityType: 'organisation',
        entityId: ctx.organisationId!,
        metadata: { promptVersion: view.promptVersion, tools: toolCatalogue.length, tokenEstimate: view.tokenEstimate.estimate },
      }),
    );
    return view;
  }
}

async function schemaBytes(t: ToolSet[string]): Promise<number> {
  try {
    const schema = await asSchema((t as { inputSchema: Parameters<typeof asSchema>[0] }).inputSchema).jsonSchema;
    return Buffer.byteLength(JSON.stringify(schema), 'utf8');
  } catch {
    return 0;
  }
}
