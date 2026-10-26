import type {
  AiAgentCreateRequest,
  AiAgentRoleFlag,
  AiAgentRoleView,
  AiAgentSchedule,
  AiAgentEventType,
  AiAgentStorageView,
  AiAgentTriggerKind,
  AiAgentTriggerView,
  AiAgentUpdateRequest,
  AiAgentView,
  AiAssistantProfileUpdateRequest,
  AiAssistantProfileView,
  AiModelLevel,
  AiModelPolicyUpdateRequest,
  AiModelSettingsView,
  AiModelSettingsViewV2,
  AiModelTier,
  AiPromptPreviewView,
  AiSettingsOverview,
  AiSkillSettingsView,
  AiToolCatalogueView,
  AiUsageView,
  AiWorkspaceInstructionsView,
} from '@rab/shared';

import { api } from '../../../shared/api';

/**
 * Settings → AI client (C8-5: moved out of the chat feature). The organisation's CEO only: the server checks
 * `ai.settings` + the CEO predicate on every route; writes that need it ask a reason and a recent step-up (the shared
 * StepUpHost replays a 403 STEP_UP_REQUIRED once). Organisation, workspace and user are never sent; every body is the
 * exact contract request (no spread of client objects), so a stray `organisationId` / `status` can never travel.
 *
 * `GET /ai/settings/models` answers the Phase 1 shape today and the C1 `AiModelSettingsViewV2` (levels + policy) after
 * the CD-1 merge; the Models tab reads `levels` / `policy` only when they are present.
 */
export type AiModelSettingsAny = AiModelSettingsView & Partial<Pick<AiModelSettingsViewV2, 'levels' | 'policy'>> & { models: AiModelSettingsViewV2['models'] | AiModelSettingsView['models'] };

const level = (l: AiModelLevel | AiModelTier) => encodeURIComponent(l);

export const aiSettingsApi = {
  overview: async () => (await api.get<AiSettingsOverview>('/ai/settings')).data,
  tools: async () => (await api.get<AiToolCatalogueView>('/ai/settings/tools')).data,
  promptPreview: async () => (await api.get<AiPromptPreviewView>('/ai/settings/prompt-preview')).data,

  models: async () => (await api.get<AiModelSettingsAny>('/ai/settings/models')).data,
  /** Pins `modelId` for a tier (Phase 1) or a level (C1: the path parameter is a level key). */
  pin: async (key: AiModelLevel | AiModelTier, modelId: string, reason: string) =>
    (await api.put<AiModelSettingsAny>(`/ai/settings/models/${level(key)}`, { modelId, reason })).data,
  /** "Choose automatically": removes the pin. */
  unpin: async (key: AiModelLevel | AiModelTier, reason: string) =>
    (await api.delete<AiModelSettingsAny>(`/ai/settings/models/${level(key)}`, { data: { reason } })).data,
  /** CD-1/CD-2: chat level, allowed levels, residency (reason + step-up). Only the named fields are sent. */
  policy: async (change: AiModelPolicyUpdateRequest) => {
    const body: AiModelPolicyUpdateRequest = { reason: change.reason };
    if (change.chatLevel) body.chatLevel = change.chatLevel;
    if (change.allowedLevels) body.allowedLevels = [...change.allowedLevels];
    if (change.dataResidency) body.dataResidency = change.dataResidency;
    return (await api.put<AiModelSettingsAny>('/ai/settings/model-policy', body)).data;
  },

  /** CD-3 (cosmetic: no reason, no step-up). Either a preset alone, or the custom fields. */
  assistant: async () => (await api.get<AiAssistantProfileView>('/ai/settings/assistant')).data,
  updateAssistant: async (change: AiAssistantProfileUpdateRequest) => {
    const body: AiAssistantProfileUpdateRequest = change.preset
      ? { preset: change.preset, ...(change.animate !== undefined ? { animate: change.animate } : {}) }
      : {
          ...(change.name !== undefined ? { name: change.name } : {}),
          ...(change.shape ? { shape: change.shape } : {}),
          ...(change.colour ? { colour: change.colour } : {}),
          ...(change.face ? { face: change.face } : {}),
          ...(change.animate !== undefined ? { animate: change.animate } : {}),
        };
    return (await api.put<AiAssistantProfileView>('/ai/settings/assistant', body)).data;
  },
  resetAssistant: async () => (await api.delete<AiAssistantProfileView>('/ai/settings/assistant')).data,

  /** CD-4 (reason + step-up). */
  instructions: async () => (await api.get<AiWorkspaceInstructionsView>('/ai/settings/instructions')).data,
  saveInstructions: async (content: string, reason: string) => (await api.put<AiWorkspaceInstructionsView>('/ai/settings/instructions', { content, reason })).data,
  removeInstructions: async (reason: string) => (await api.delete<AiWorkspaceInstructionsView>('/ai/settings/instructions', { data: { reason } })).data,

  /** Phase 4. */
  skills: async () => (await api.get<AiSkillSettingsView>('/ai/settings/skills')).data,
  createSkill: async (input: { name: string; label: string; description: string; content: string; reason: string }) =>
    (await api.post('/ai/settings/skills', { name: input.name, label: input.label, description: input.description, content: input.content, reason: input.reason })).data,
  updateSkill: async (id: string, input: { label: string; description: string; content: string; reason: string }) =>
    (await api.patch(`/ai/settings/skills/${encodeURIComponent(id)}`, { label: input.label, description: input.description, content: input.content, reason: input.reason })).data,
  deleteSkill: async (id: string, reason: string) => (await api.delete(`/ai/settings/skills/${encodeURIComponent(id)}`, { data: { reason } })).data,
  /** Named actions only (never a raw `isActive`). Built-ins are addressed by name until they have a row. */
  setSkillActive: async (skill: { id: string | null; name: string; isSystem: boolean }, active: boolean, reason: string) => {
    const verb = active ? 'activate' : 'deactivate';
    const path = skill.isSystem ? `/ai/settings/skills/builtin/${encodeURIComponent(skill.name)}/${verb}` : `/ai/settings/skills/${encodeURIComponent(skill.id ?? '')}/${verb}`;
    return (await api.post(path, { reason })).data;
  },

  /** Phase 7 (metadata only; audited server-side). */
  usage: async (period: 'today' | 'month') => (await api.get<AiUsageView>('/ai/settings/usage', { params: { period } })).data,

  /**
   * Phase 6a — STORAGE ONLY (EX-3 not approved: no enable, no run, no test). Every write carries a reason (audited) and
   * needs a recent step-up (`organisation.ai.agent.update`): `AiReasonDialog` collects the reason and the shared
   * StepUpHost answers a 403 STEP_UP_REQUIRED. Every body is built field by field (never a spread of a client object).
   */
  agents: async () => (await api.get<AiAgentListAny>('/ai/agents')).data,
  agent: async (id: string) => (await api.get<AiAgentRow>(`/ai/agents/${encodeURIComponent(id)}`)).data,
  createAgent: async (input: AiAgentCreateRequest & { reason: string }) => {
    const body: AiAgentCreateRequest & { reason: string } = {
      name: input.name,
      label: input.label,
      prompt: input.prompt,
      model: { tier: input.model.tier, modelId: input.model.modelId },
      reason: input.reason,
    };
    if (input.description !== undefined) body.description = input.description;
    return (await api.post<AiAgentRow>('/ai/agents', body)).data;
  },
  updateAgent: async (id: string, change: AiAgentUpdateRequest, reason: string) => {
    const body: AiAgentUpdateRequest & { reason: string } = { reason };
    if (change.label !== undefined) body.label = change.label;
    if (change.description !== undefined) body.description = change.description;
    if (change.prompt !== undefined) body.prompt = change.prompt;
    if (change.model !== undefined) body.model = { tier: change.model.tier, modelId: change.model.modelId };
    if (change.roleId !== undefined) body.roleId = change.roleId;
    return (await api.patch<AiAgentRow>(`/ai/agents/${encodeURIComponent(id)}`, body)).data;
  },
  deleteAgent: async (id: string, reason: string) => (await api.delete(`/ai/agents/${encodeURIComponent(id)}`, { data: { reason } })).data,
  agentRole: async (id: string) => (await api.get<AiAgentRoleAny>(`/ai/agents/${encodeURIComponent(id)}/role`)).data,
  setAgentRole: async (id: string, flags: AiAgentRoleFlag[], reason: string) =>
    (await api.put<AiAgentRoleAny>(`/ai/agents/${encodeURIComponent(id)}/role`, { flags: [...flags], reason })).data,
  createTrigger: async (id: string, input: { kind: AiAgentTriggerKind; schedule?: AiAgentSchedule; eventTypes?: AiAgentEventType[] }, reason: string) => {
    const body: { kind: AiAgentTriggerKind; schedule?: AiAgentSchedule; eventTypes?: AiAgentEventType[]; reason: string } = { kind: input.kind, reason };
    if (input.kind === 'schedule' && input.schedule) body.schedule = { every: input.schedule.every, at: input.schedule.at, ...(input.schedule.dow !== undefined ? { dow: input.schedule.dow } : {}) };
    if (input.kind === 'record_event' && input.eventTypes) body.eventTypes = [...input.eventTypes];
    return (await api.post<AiAgentTriggerView>(`/ai/agents/${encodeURIComponent(id)}/triggers`, body)).data;
  },
  deleteTrigger: async (id: string, triggerId: string, reason: string) =>
    (await api.delete(`/ai/agents/${encodeURIComponent(id)}/triggers/${encodeURIComponent(triggerId)}`, { data: { reason } })).data,
};

/** One agent as `/ai/agents` answers it: the C0 view, plus `kind` / `readOnly` from 6a storage (optional for an older server). */
export type AiAgentRow = AiAgentView & Partial<Pick<AiAgentStorageView, 'kind' | 'readOnly'>>;
type AiAgentListAny = AiAgentRow[] | { data: AiAgentRow[] };
/** The role view of 6a: `roleId` is null while the agent has no role yet (= no tools). */
export type AiAgentRoleAny = Omit<AiAgentRoleView, 'roleId'> & { roleId: string | null };

/** Standard / system agents are never edited or deleted (`readOnly` from the server; a non-custom kind means the same). */
export const agentIsReadOnly = (a: AiAgentRow) => a.readOnly === true || (a.kind !== undefined && a.kind !== 'custom');

/** The agents list answers either an array or `{data}` (6a decides); always read it as an array. */
export function agentList(value: AiAgentRow[] | { data: AiAgentRow[] } | undefined): AiAgentRow[] {
  if (!value) return [];
  return Array.isArray(value) ? value : value.data ?? [];
}
