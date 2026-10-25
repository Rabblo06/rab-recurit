import { AI_SKILL_LIMITS, AiSkillActionRequest, AiSkillCreateRequest, AiSkillUpdateRequest } from '@rab/shared';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/**
 * Settings → AI → Skills request bodies (docs/ai/PHASE4_TWENTY_PLAN.md §2.6, AI_CONTRACTS §3). The organisation, the
 * author and the state come from the verified session and the NAMED route — a body carrying `organisationId`,
 * `isSystem`, `isActive`, `status`, `createdBy`/`updatedBy`, or `name` on PATCH, is a 400 (forbidNonWhitelisted, wired
 * globally), never silently applied.
 *
 * The bounds and the content rules of `name`, `label`, `description` and `content` are enforced by the service
 * (skills/skill-content-rules.ts → 400 `AI_SKILL_CONTENT_REFUSED` with fixed category codes) so every caller — HTTP or
 * not — gets the same answer; the DTO only types them. The reason is checked here AND in the service.
 */
export class CreateAiSkillDto implements AiSkillCreateRequest {
  @IsString()
  name!: string;

  @IsString()
  label!: string;

  @IsString()
  description!: string;

  @IsString()
  content!: string;

  @IsString()
  @MinLength(AI_SKILL_LIMITS.reasonMinChars)
  @MaxLength(AI_SKILL_LIMITS.reasonMaxChars)
  reason!: string;
}

/** `PATCH /rest/v1/ai/settings/skills/:id` — label, description and content only; a name never changes. */
export class UpdateAiSkillDto implements AiSkillUpdateRequest {
  @IsOptional()
  @IsString()
  label?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  content?: string;

  @IsString()
  @MinLength(AI_SKILL_LIMITS.reasonMinChars)
  @MaxLength(AI_SKILL_LIMITS.reasonMaxChars)
  reason!: string;
}

/** Body of every named action: delete, activate, deactivate (custom and built-in). */
export class AiSkillActionDto implements AiSkillActionRequest {
  @IsString()
  @MinLength(AI_SKILL_LIMITS.reasonMinChars)
  @MaxLength(AI_SKILL_LIMITS.reasonMaxChars)
  reason!: string;
}
