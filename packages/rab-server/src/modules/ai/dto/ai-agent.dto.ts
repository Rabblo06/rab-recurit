import { AI_AGENT_EVENT_TYPES, AI_AGENT_REASON_LIMITS, AI_AGENT_ROLE_ALLOWLIST, AiAgentEventType, AiAgentRoleFlag, AiAgentTriggerKind } from '@rab/shared';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsIn, IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, MinLength, ValidateIf, ValidateNested } from 'class-validator';

/**
 * Settings → AI → Agents request bodies (docs/ai/PHASE6_TWENTY_PLAN.md §4; route table AI_API_ROUTES, AI_CONTRACTS §3).
 * The organisation, workspace, author, kind and every state come from the verified session and the NAMED route — a body
 * carrying `organisationId`, `workspaceId`, `runAsUserId`, `enabled`, `status`, `isActive`, `kind`, `configVersion`,
 * `createdBy`/`updatedBy`, or `name` on PATCH is a 400 (forbidNonWhitelisted, wired globally — nested objects too),
 * never silently applied. The controller maps each allowed field explicitly; nothing is spread into a query.
 *
 * Text bounds and content rules (name, label, description, prompt ≤ 8,000) are enforced by the service
 * (agents/agent-content-rules.ts → 400 AI_AGENT_CONTENT_REFUSED with fixed category codes), so every caller gets the same
 * answer; the DTO only types them. The reason is checked here AND in the service.
 */
const MODEL_ID = /^[a-z0-9][a-z0-9._-]{0,99}$/;
const HH_MM = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

export class AiAgentModelDto {
  @IsIn(['fast', 'smart'])
  tier!: 'fast' | 'smart';

  /** A catalogue LOOKUP key of `tier`, or null ("use the tier"). The service checks the catalogue. */
  @ValidateIf((_, value) => value !== null && value !== undefined)
  @IsString()
  @Matches(MODEL_ID)
  modelId!: string | null;
}

class AiAgentReasonField {
  @IsString()
  @MinLength(AI_AGENT_REASON_LIMITS.minChars)
  @MaxLength(AI_AGENT_REASON_LIMITS.maxChars)
  reason!: string;
}

export class CreateAiAgentDto extends AiAgentReasonField {
  @IsString()
  name!: string;

  @IsString()
  label!: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsString()
  prompt!: string;

  @ValidateNested()
  @Type(() => AiAgentModelDto)
  model!: AiAgentModelDto;

  @IsOptional()
  @IsIn(['text'])
  responseFormat?: 'text';

  /** An agent role of the caller's workspace (null or absent = no role = no tools). */
  @IsOptional()
  @IsUUID()
  roleId?: string | null;
}

/** `PATCH /rest/v1/ai/agents/:id` — a name never changes. */
export class UpdateAiAgentDto extends AiAgentReasonField {
  @IsOptional()
  @IsString()
  label?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  prompt?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => AiAgentModelDto)
  model?: AiAgentModelDto;

  @IsOptional()
  @IsIn(['text'])
  responseFormat?: 'text';

  /** `null` detaches the role (no tools); a uuid attaches an agent role of this workspace. */
  @IsOptional()
  @IsUUID()
  roleId?: string | null;
}

/** Body of every named action without other fields: delete an agent or trigger, enable (refused), disable. */
export class AiAgentActionDto extends AiAgentReasonField {}

export class AiAgentScheduleDto {
  @IsIn(['hour', 'day', 'weekday', 'week'])
  every!: 'hour' | 'day' | 'weekday' | 'week';

  @IsString()
  @Matches(HH_MM)
  at!: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(6)
  dow?: 0 | 1 | 2 | 3 | 4 | 5 | 6;
}

export class CreateAiAgentTriggerDto extends AiAgentReasonField {
  @IsIn(['schedule', 'record_event'])
  kind!: AiAgentTriggerKind;

  @IsOptional()
  @ValidateNested()
  @Type(() => AiAgentScheduleDto)
  schedule?: AiAgentScheduleDto;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(4)
  @IsIn(AI_AGENT_EVENT_TYPES as unknown as string[], { each: true })
  eventTypes?: AiAgentEventType[];
}

/** `PATCH …/triggers/:triggerId` — the kind never changes; `enabled` is never a field (named routes only). */
export class UpdateAiAgentTriggerDto extends AiAgentReasonField {
  @IsOptional()
  @ValidateNested()
  @Type(() => AiAgentScheduleDto)
  schedule?: AiAgentScheduleDto;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(4)
  @IsIn(AI_AGENT_EVENT_TYPES as unknown as string[], { each: true })
  eventTypes?: AiAgentEventType[];
}

/** `PUT /rest/v1/ai/agents/:id/role` — the agent role's flags (only the C1 agent allowlist; 6a grants the view subset). */
export class SetAiAgentRoleDto extends AiAgentReasonField {
  @IsArray()
  @ArrayMaxSize(AI_AGENT_ROLE_ALLOWLIST.length)
  @IsIn(AI_AGENT_ROLE_ALLOWLIST as unknown as string[], { each: true })
  flags!: AiAgentRoleFlag[];
}
