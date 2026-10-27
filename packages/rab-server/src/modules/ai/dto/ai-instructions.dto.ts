import { AI_INSTRUCTIONS_LIMITS, AiWorkspaceInstructionsDeleteRequest, AiWorkspaceInstructionsUpdateRequest } from '@rab/shared';
import { IsString, MaxLength, MinLength } from 'class-validator';

/**
 * Settings → AI → Instructions bodies (C1 / CD-4). The organisation and the author come from the verified session; a
 * body carrying `organisationId`, `updatedBy`, `contentSha256` or any other key is a 400 (forbidNonWhitelisted). The
 * content rules (skills/skill-content-rules.ts `checkInstructionContent`) run in the service so every caller gets the
 * same answer; the DTO only types the content. The reason is checked here AND in the service.
 */
export class UpdateAiInstructionsDto implements AiWorkspaceInstructionsUpdateRequest {
  @IsString()
  content!: string;

  @IsString()
  @MinLength(AI_INSTRUCTIONS_LIMITS.reasonMinChars)
  @MaxLength(AI_INSTRUCTIONS_LIMITS.reasonMaxChars)
  reason!: string;
}

export class DeleteAiInstructionsDto implements AiWorkspaceInstructionsDeleteRequest {
  @IsString()
  @MinLength(AI_INSTRUCTIONS_LIMITS.reasonMinChars)
  @MaxLength(AI_INSTRUCTIONS_LIMITS.reasonMaxChars)
  reason!: string;
}
