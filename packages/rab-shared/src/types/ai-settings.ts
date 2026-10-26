/**
 * AI contracts C0 — UI APIS (docs/ai/AI_CONTRACTS.md §2.8 and the route table §3). Types and fixed values only.
 *
 * A Settings → AI tab or a chat card renders ONLY when the server says its API exists and is on (`features`), never from a
 * client-side guess and never against fixtures in production code (no mock production logic). The server sets a flag
 * true only once the owning phase has merged.
 */
import type { AiModelTier, AiUnavailableReasonType } from './ai';
import type { AiAssistantProfileView } from './ai-assistant';
import type { AiAvailabilityLevelsView, AiModelLevel, AiPromptCacheMode, AiSetupNeededV2 } from './ai-models';
import type { AiSkillSummaryView } from './ai-skills';
import type { AiWriteToolName } from './ai-proposals';
import type { AiAvailabilityLimitsV2, AiAvailabilityUsageV2 } from './ai-usage';

/** `GET /rest/v1/ai/settings` (Phase 8; CEO + `ai.settings`). */
export interface AiSettingsOverview {
  features: {
    /** Phase 4 merged: Skills tab + composer tags. */
    skills: boolean;
    /** Phase 3 merged: Tools tab. */
    tools: boolean;
    /** Phase 7 merged: Usage tab and allowance meter. */
    usage: boolean;
    /** Phase 8 prompt preview endpoint. */
    promptPreview: boolean;
    /** Phase 5b merged: approval / question / form cards. */
    approvals: boolean;
    /** Phase 6a merged AND `AI_AGENTS_ENABLED`: Agents tab (storage). */
    agents: boolean;
    /** Always false until EX-3 is approved (owner decision 2026-10-25). */
    agentExecution: false;
    /** C1 (CD-3): assistant name + avatar API exists. Optional until the CD-3 merge. */
    assistant?: boolean;
    /** C1 (CD-4): workspace instructions API exists (Phase 4w). */
    instructions?: boolean;
    /** C1 (CD-1): five levels + model policy API exists. */
    levels?: boolean;
    /** C1 (CD-8): `GET /ai/capabilities` exists (Phase 3w). */
    capabilities?: boolean;
  };
  /** C1 (CD-10): at-a-glance counts (own conversations by owner RLS; org questions from `ai_usage_daily`, counts only). */
  counts?: { myConversations: number; orgQuestionsThisMonth: number; activeSkills: number; tools: number };
  limits: {
    maxInputChars: number;
    userRatePerMinute: number;
    orgRatePerMinute: number;
    userTurnsPerDay: number;
    orgDailyTokenBudget: number;
    orgDailyCostCeilingMicros: number;
    userDailyCostCeilingMicros: number;
  };
}

/**
 * `GET /rest/v1/ai/settings/prompt-preview` (Phase 8; CEO + `ai.settings`; audited `ai.prompt_previewed`). Exactly the
 * fixed prefix the next chat request would send for THIS caller: no history, no tool results, no record rows of anyone.
 * Secret-scanned before it is returned (a hit is a 500 with a fixed code, never the text). Rendered as plain text.
 */
export interface AiPromptPreviewView {
  promptVersion: string;
  tier: AiModelTier;
  modelId: string | null;
  systemPrompt: string;
  /** Phase 4 skill lines (`name: description`), in prompt order; empty before Phase 4. */
  skillCatalogue: string[];
  /** Phase 3 tool catalogue lines the caller would be offered. */
  toolCatalogue: { name: string; summary: string }[];
  sdkTools: { name: string; schemaBytes: number }[];
  /** Local estimate only (bytes bound and chars/4); no provider count-tokens call. */
  tokenEstimate: { estimate: number; upperBound: number };
  promptCache: AiPromptCacheMode;
  generatedAt: string;
  /**
   * C1 (CD-5): the same prompt as ordered, read-only sections. Their texts joined by `AI_PROMPT_SECTION_SEPARATOR` are
   * byte-equal to `systemPrompt` (= what the gateway sends for this actor). Optional until the CD-5 merge.
   */
  sections?: AiPromptSectionView[];
  totalTokenEstimate?: { estimate: number; upperBound: number };
}

/** C1 (CD-5): prompt section keys, in prompt order. `context` holds the only per-request values (org-local date + timezone; never a user name). */
export const AI_PROMPT_SECTION_KEYS = ['rules', 'format', 'instructions', 'skills', 'tools', 'context'] as const;
export type AiPromptSectionKey = (typeof AI_PROMPT_SECTION_KEYS)[number];
/** Sections are joined with exactly this string (empty sections are omitted, not joined). */
export const AI_PROMPT_SECTION_SEPARATOR = '\n\n';

export interface AiPromptSectionView {
  key: AiPromptSectionKey;
  title: string;
  text: string;
  readOnly: true;
  tokenEstimate: { estimate: number; upperBound: number };
}

/** C1 (CD-8): `GET /rest/v1/ai/capabilities` ("See what I can do"; `ai.use` + AiAvailableGuard; 404 when AI is off). */
export interface AiCapabilitiesView {
  /** The caller's PERMITTED read tools (the same `forTurn` filter; no second registry). */
  tools: { name: string; label: string; summary: string }[];
  skills: AiSkillSummaryView[];
  /**
   * Batch 3 (S4, Agent 9 decision): exactly the write tools this caller may PROPOSE (the `propose_action` filter,
   * `AiToolRegistry.permittedWriteTools`, flags re-read from PostgreSQL); approval-only, fixed server labels. [] without a flag.
   */
  writeTools: { name: AiWriteToolName; label: string; summary: string }[];
}

/**
 * C1: `GET /rest/v1/ai/availability`, target shape. Phase 1 fields + Phase 7 usage + CD-1 levels + CD-3 assistant
 * profile (so the chat needs no extra fetch). When unavailable: `usage`, `levels` and `assistant` are null and `reason`
 * is set (the four 404 reasons disclose nothing about the configuration).
 */
export interface AiAvailabilityViewV2 {
  available: boolean;
  reason: AiUnavailableReasonType | null;
  setup?: AiSetupNeededV2;
  limits: AiAvailabilityLimitsV2;
  usage: AiAvailabilityUsageV2 | null;
  levels: AiAvailabilityLevelsView | null;
  assistant: AiAssistantProfileView | null;
}

/** The levels a submit may name (re-exported for DTO validation on both sides). */
export type AiSubmitLevel = AiModelLevel;

export type AiRouteMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** One row of the AI route table. Paths are under `/rest/v1`. `phase` = the phase whose merge makes the route exist. */
export interface AiRouteContract {
  method: AiRouteMethod;
  path: string;
  phase: 1 | 3 | 4 | 5 | 6 | 7 | 8;
  /** Layer 1 guard flag (the service re-checks it, layer 2). */
  permission: 'ai.use' | 'ai.settings' | 'ai.agents.manage' | 'schedule.create' | 'platform_admin';
  /** The owning agent's controller file under `packages/rab-server/src/modules/ai/controllers/` (or the domain path). */
  controller: string;
}

/**
 * The single route table for every phase (resolution X-6, X-11). Existing Phase 1 routes are listed for completeness. A
 * route not in this table is not part of the contract; adding one is an integration request to Agent 9.
 */
export const AI_API_ROUTES: readonly AiRouteContract[] = [
  { method: 'GET', path: '/ai/availability', phase: 1, permission: 'ai.use', controller: 'ai-conversation.controller.ts' },
  { method: 'POST', path: '/ai/conversations', phase: 1, permission: 'ai.use', controller: 'ai-conversation.controller.ts' },
  { method: 'GET', path: '/ai/conversations', phase: 1, permission: 'ai.use', controller: 'ai-conversation.controller.ts' },
  { method: 'GET', path: '/ai/conversations/:id', phase: 1, permission: 'ai.use', controller: 'ai-conversation.controller.ts' },
  { method: 'DELETE', path: '/ai/conversations/:id', phase: 1, permission: 'ai.use', controller: 'ai-conversation.controller.ts' },
  { method: 'POST', path: '/ai/conversations/:id/messages', phase: 1, permission: 'ai.use', controller: 'ai-conversation.controller.ts' },
  { method: 'POST', path: '/ai/conversations/:id/turns/:turnId/cancel', phase: 1, permission: 'ai.use', controller: 'ai-conversation.controller.ts' },
  { method: 'GET', path: '/ai/conversations/:id/stream', phase: 1, permission: 'ai.use', controller: 'ai-conversation.controller.ts' },
  { method: 'GET', path: '/ai/settings/models', phase: 1, permission: 'ai.settings', controller: 'ai-settings.controller.ts' },
  /** C1 (CD-1): the path parameter is a LEVEL key (the five levels); `fast` / `smart` pins stay valid as level keys. */
  { method: 'PUT', path: '/ai/settings/models/:level', phase: 1, permission: 'ai.settings', controller: 'ai-settings.controller.ts' },
  { method: 'DELETE', path: '/ai/settings/models/:level', phase: 1, permission: 'ai.settings', controller: 'ai-settings.controller.ts' },
  { method: 'PUT', path: '/ai/settings/model-policy', phase: 1, permission: 'ai.settings', controller: 'ai-model-policy.controller.ts' },
  { method: 'GET', path: '/ai/settings/assistant', phase: 8, permission: 'ai.settings', controller: 'ai-assistant.controller.ts' },
  { method: 'PUT', path: '/ai/settings/assistant', phase: 8, permission: 'ai.settings', controller: 'ai-assistant.controller.ts' },
  { method: 'DELETE', path: '/ai/settings/assistant', phase: 8, permission: 'ai.settings', controller: 'ai-assistant.controller.ts' },
  { method: 'GET', path: '/ai/settings/instructions', phase: 4, permission: 'ai.settings', controller: 'ai-instructions.controller.ts' },
  { method: 'PUT', path: '/ai/settings/instructions', phase: 4, permission: 'ai.settings', controller: 'ai-instructions.controller.ts' },
  { method: 'DELETE', path: '/ai/settings/instructions', phase: 4, permission: 'ai.settings', controller: 'ai-instructions.controller.ts' },
  { method: 'GET', path: '/ai/capabilities', phase: 3, permission: 'ai.use', controller: 'ai-capabilities.controller.ts' },
  { method: 'GET', path: '/ai/skills', phase: 4, permission: 'ai.use', controller: 'ai-skills.controller.ts' },
  { method: 'GET', path: '/ai/settings/skills', phase: 4, permission: 'ai.settings', controller: 'ai-skills.controller.ts' },
  { method: 'POST', path: '/ai/settings/skills', phase: 4, permission: 'ai.settings', controller: 'ai-skills.controller.ts' },
  { method: 'PATCH', path: '/ai/settings/skills/:id', phase: 4, permission: 'ai.settings', controller: 'ai-skills.controller.ts' },
  { method: 'DELETE', path: '/ai/settings/skills/:id', phase: 4, permission: 'ai.settings', controller: 'ai-skills.controller.ts' },
  { method: 'POST', path: '/ai/settings/skills/:id/activate', phase: 4, permission: 'ai.settings', controller: 'ai-skills.controller.ts' },
  { method: 'POST', path: '/ai/settings/skills/:id/deactivate', phase: 4, permission: 'ai.settings', controller: 'ai-skills.controller.ts' },
  { method: 'POST', path: '/ai/settings/skills/builtin/:name/activate', phase: 4, permission: 'ai.settings', controller: 'ai-skills.controller.ts' },
  { method: 'POST', path: '/ai/settings/skills/builtin/:name/deactivate', phase: 4, permission: 'ai.settings', controller: 'ai-skills.controller.ts' },
  { method: 'GET', path: '/ai/conversations/:id/proposals', phase: 5, permission: 'ai.use', controller: 'ai-proposal.controller.ts' },
  { method: 'POST', path: '/ai/proposals/:id/approve', phase: 5, permission: 'ai.use', controller: 'ai-proposal.controller.ts' },
  { method: 'POST', path: '/ai/proposals/:id/reject', phase: 5, permission: 'ai.use', controller: 'ai-proposal.controller.ts' },
  { method: 'POST', path: '/ai/conversations/:id/inputs/:requestId/answer', phase: 5, permission: 'ai.use', controller: 'ai-proposal.controller.ts' },
  // Batch 3 (S7): the question / form cards of a conversation (`AiInputRequestView[]`), as `…/proposals` lists the approval cards.
  { method: 'GET', path: '/ai/conversations/:id/inputs', phase: 5, permission: 'ai.use', controller: 'ai-proposal.controller.ts' },
  { method: 'PATCH', path: '/shifts/:id/draft', phase: 5, permission: 'schedule.create', controller: 'modules/scheduling/controllers/scheduling.controller.ts' },
  { method: 'GET', path: '/ai/agents', phase: 6, permission: 'ai.agents.manage', controller: 'ai-agent.controller.ts' },
  { method: 'POST', path: '/ai/agents', phase: 6, permission: 'ai.agents.manage', controller: 'ai-agent.controller.ts' },
  { method: 'GET', path: '/ai/agents/:id', phase: 6, permission: 'ai.agents.manage', controller: 'ai-agent.controller.ts' },
  { method: 'PATCH', path: '/ai/agents/:id', phase: 6, permission: 'ai.agents.manage', controller: 'ai-agent.controller.ts' },
  { method: 'DELETE', path: '/ai/agents/:id', phase: 6, permission: 'ai.agents.manage', controller: 'ai-agent.controller.ts' },
  { method: 'POST', path: '/ai/agents/:id/triggers', phase: 6, permission: 'ai.agents.manage', controller: 'ai-agent.controller.ts' },
  { method: 'PATCH', path: '/ai/agents/:id/triggers/:triggerId', phase: 6, permission: 'ai.agents.manage', controller: 'ai-agent.controller.ts' },
  { method: 'DELETE', path: '/ai/agents/:id/triggers/:triggerId', phase: 6, permission: 'ai.agents.manage', controller: 'ai-agent.controller.ts' },
  /** Refused with AI_AGENT_EXECUTION_NOT_APPROVED until the owner approves EX-3; `disable` always works. No run / runs route before 6b. */
  { method: 'POST', path: '/ai/agents/:id/triggers/:triggerId/enable', phase: 6, permission: 'ai.agents.manage', controller: 'ai-agent.controller.ts' },
  { method: 'POST', path: '/ai/agents/:id/triggers/:triggerId/disable', phase: 6, permission: 'ai.agents.manage', controller: 'ai-agent.controller.ts' },
  { method: 'GET', path: '/ai/settings/usage', phase: 7, permission: 'ai.settings', controller: 'ai-usage-settings.controller.ts' },
  { method: 'GET', path: '/ai/settings', phase: 8, permission: 'ai.settings', controller: 'ai-settings.controller.ts' },
  { method: 'GET', path: '/ai/settings/tools', phase: 8, permission: 'ai.settings', controller: 'ai-settings.controller.ts' },
  { method: 'GET', path: '/ai/settings/prompt-preview', phase: 8, permission: 'ai.settings', controller: 'ai-settings.controller.ts' },
  { method: 'GET', path: '/admin/ai/overview', phase: 1, permission: 'platform_admin', controller: 'ai-admin.controller.ts' },
  { method: 'GET', path: '/admin/ai/usage', phase: 1, permission: 'platform_admin', controller: 'ai-admin.controller.ts' },
  { method: 'GET', path: '/admin/ai/organisations/:organisationId/setting', phase: 1, permission: 'platform_admin', controller: 'ai-admin.controller.ts' },
  { method: 'PUT', path: '/admin/ai/organisations/:organisationId/setting', phase: 1, permission: 'platform_admin', controller: 'ai-admin.controller.ts' },
];
