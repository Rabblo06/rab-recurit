import { createHash } from 'node:crypto';

import { AiAgentEventType, AiAgentKind, AiAgentPauseReasonType, AiAgentSchedule, AiAgentStorageView, AiAgentTriggerKind, AiAgentTriggerView, AiModelTier } from '@rab/shared';
import { HttpException } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import { AiRecordNotFoundException } from '../exceptions/ai.exceptions';
import {
  AiAgentContentRefusedException,
  AiAgentInvalidException,
  AiAgentLimitReachedException,
  AiAgentNameTakenException,
  AiAgentReadOnlyException,
  AiAgentTriggerLimitReachedException,
} from '../exceptions/ai-agent.exceptions';

/**
 * Row access shared by the Phase 6a agent services (agent, trigger, role). Every query runs inside the caller's own
 * tenant transaction (crewflow_app, FORCE RLS: the bound organisation AND workspace, eligible readers, CEO writer) and is
 * ALSO scoped explicitly to the caller's organisation and workspace (layer 3). Anything not found there is the uniform
 * 404 — another organisation's or workspace's agent is indistinguishable from one that never existed.
 */
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

export interface AgentRow {
  id: string;
  kind: AiAgentKind;
  name: string;
  label: string;
  description: string | null;
  prompt: string;
  model_tier: AiModelTier;
  model_id: string | null;
  response_format: 'text';
  role_id: string | null;
  is_active: boolean;
  config_version: number;
  created_at: Date | string;
  updated_at: Date | string;
}

export interface TriggerRow {
  id: string;
  agent_id: string;
  kind: AiAgentTriggerKind;
  schedule: AiAgentSchedule | null;
  event_types: AiAgentEventType[] | null;
  enabled: boolean;
  run_as_user_id: string | null;
  paused_reason: AiAgentPauseReasonType | null;
  next_run_at: Date | string | null;
  last_run_at: Date | string | null;
}

export interface Scope {
  organisationId: string;
  workspaceId: string;
}

const AGENT_COLUMNS = `id, kind, name, label, description, prompt, model_tier, model_id, response_format, role_id, is_active, config_version, created_at, updated_at`;
const TRIGGER_COLUMNS = `id, agent_id, kind, schedule, event_types, enabled, run_as_user_id, paused_reason, next_run_at, last_run_at`;
const iso = (value: Date | string) => new Date(value).toISOString();
const isoOrNull = (value: Date | string | null) => (value === null ? null : iso(value));

export function scopeOf(ctx: { organisationId?: string | null; workspaceId?: string | null }): Scope {
  return { organisationId: ctx.organisationId!, workspaceId: ctx.workspaceId! };
}

/** Live agents of the scope, newest first, each with its triggers. */
export async function listAgentViews(m: EntityManager, scope: Scope): Promise<AiAgentStorageView[]> {
  const agents = await m.query<AgentRow[]>(
    `SELECT ${AGENT_COLUMNS} FROM core.ai_agent WHERE organisation_id = $1 AND workspace_id = $2 AND deleted_at IS NULL ORDER BY created_at DESC, id`,
    [scope.organisationId, scope.workspaceId],
  );
  if (agents.length === 0) return [];
  const triggers = await m.query<TriggerRow[]>(
    `SELECT ${TRIGGER_COLUMNS} FROM core.ai_agent_trigger WHERE organisation_id = $1 AND workspace_id = $2 AND agent_id = ANY($3::uuid[]) ORDER BY created_at, id`,
    [scope.organisationId, scope.workspaceId, agents.map((a) => a.id)],
  );
  return agents.map((a) => toView(a, triggers.filter((t) => t.agent_id === a.id)));
}

/** One live agent of the scope (404 otherwise), with its triggers. */
export async function agentView(m: EntityManager, scope: Scope, id: string): Promise<AiAgentStorageView> {
  const agent = await findAgent(m, scope, id, false);
  const triggers = await m.query<TriggerRow[]>(
    `SELECT ${TRIGGER_COLUMNS} FROM core.ai_agent_trigger WHERE organisation_id = $1 AND workspace_id = $2 AND agent_id = $3 ORDER BY created_at, id`,
    [scope.organisationId, scope.workspaceId, agent.id],
  );
  return toView(agent, triggers);
}

/** A live agent of the scope, optionally locked FOR UPDATE; absent / foreign / deleted / malformed id ⇒ 404. */
export async function findAgent(m: EntityManager, scope: Scope, id: string, lock: boolean): Promise<AgentRow> {
  if (!UUID.test(String(id))) throw new AiRecordNotFoundException();
  const [row] = await m.query<AgentRow[]>(
    `SELECT ${AGENT_COLUMNS} FROM core.ai_agent WHERE id = $1 AND organisation_id = $2 AND workspace_id = $3 AND deleted_at IS NULL${lock ? ' FOR UPDATE' : ''}`,
    [id, scope.organisationId, scope.workspaceId],
  );
  if (!row) throw new AiRecordNotFoundException();
  return row;
}

/**
 * For a write: refused 409 unless it is a CUSTOM agent (standard / system agents are read-only), then locked. The kind is
 * read WITHOUT a lock first: `SELECT … FOR UPDATE` is filtered by the UPDATE policy too (`kind = 'custom'`), so a
 * standard agent would otherwise look absent (404) instead of read-only (409).
 */
export async function lockCustomAgent(m: EntityManager, scope: Scope, id: string): Promise<AgentRow> {
  const seen = await findAgent(m, scope, id, false);
  if (seen.kind !== 'custom') throw new AiAgentReadOnlyException();
  return findAgent(m, scope, id, true);
}

/** A trigger of THIS agent in the scope, optionally locked; anything else ⇒ 404. */
export async function findTrigger(m: EntityManager, scope: Scope, agentId: string, triggerId: string, lock: boolean): Promise<TriggerRow> {
  if (!UUID.test(String(triggerId))) throw new AiRecordNotFoundException();
  const [row] = await m.query<TriggerRow[]>(
    `SELECT ${TRIGGER_COLUMNS} FROM core.ai_agent_trigger WHERE id = $1 AND agent_id = $2 AND organisation_id = $3 AND workspace_id = $4${lock ? ' FOR UPDATE' : ''}`,
    [triggerId, agentId, scope.organisationId, scope.workspaceId],
  );
  if (!row) throw new AiRecordNotFoundException();
  return row;
}

function toView(a: AgentRow, triggers: TriggerRow[]): AiAgentStorageView {
  return {
    id: a.id,
    kind: a.kind,
    readOnly: a.kind !== 'custom',
    name: a.name,
    label: a.label,
    description: a.description,
    prompt: a.prompt,
    model: { tier: a.model_tier, modelId: a.model_id },
    responseFormat: a.response_format,
    roleId: a.role_id,
    isActive: a.is_active,
    configVersion: Number(a.config_version),
    triggers: triggers.map(toTriggerView),
    createdAt: iso(a.created_at),
    updatedAt: iso(a.updated_at),
  };
}

function toTriggerView(t: TriggerRow): AiAgentTriggerView {
  return {
    id: t.id,
    agentId: t.agent_id,
    kind: t.kind,
    schedule: t.schedule,
    eventTypes: t.event_types ?? [],
    enabled: t.enabled,
    runAsUserId: t.run_as_user_id,
    pausedReason: t.paused_reason,
    nextRunAt: isoOrNull(t.next_run_at),
    lastRunAt: isoOrNull(t.last_run_at),
  };
}

export const AI_AGENT_LIMIT_CONSTRAINT = 'ai_agent_workspace_limit';
export const AI_AGENT_TRIGGER_LIMIT_CONSTRAINT = 'ai_agent_trigger_agent_limit';

/** Database refusals of a write, answered with the same fixed shapes as the services' own checks. */
export function mapAgentWriteError(error: unknown): unknown {
  if (error instanceof HttpException) return error;
  const driver = (error as { driverError?: { code?: string; constraint?: string } })?.driverError ?? (error as { code?: string; constraint?: string });
  switch (driver?.code) {
    case '23505':
      return new AiAgentNameTakenException();
    case '23514':
      if (driver.constraint === AI_AGENT_LIMIT_CONSTRAINT) return new AiAgentLimitReachedException();
      if (driver.constraint === AI_AGENT_TRIGGER_LIMIT_CONSTRAINT) return new AiAgentTriggerLimitReachedException();
      if (driver.constraint?.startsWith('ai_agent_trigger_')) return new AiAgentInvalidException('trigger');
      return new AiAgentContentRefusedException(['length']);
    case '23503':
      // The composite role FK refused a role that is not an agent role of this workspace (the service checks first).
      return new AiAgentInvalidException('roleId');
    case '42501':
      // RLS (layers 4–5) refused a write the service let through: answered as "not found", never as "forbidden".
      return new AiRecordNotFoundException();
    default:
      return error;
  }
}
