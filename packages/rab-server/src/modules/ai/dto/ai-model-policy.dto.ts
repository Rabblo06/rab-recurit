import { AI_DATA_RESIDENCIES, AI_MODEL_LEVEL_KEYS, AiDataResidency, AiModelLevel } from '@rab/shared';
import { ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/**
 * `PUT /rest/v1/ai/settings/model-policy` (C1 / CD-1 / CD-2; CEO only). Enum values only; the organisation, the user and
 * any status come from the verified session. Any other key (`organisationId`, `status`, a model id, …) is a 400
 * (forbidNonWhitelisted). There is no `us` residency (rule 3.7).
 */
export class UpdateAiModelPolicyDto {
  @IsOptional()
  @IsIn(AI_MODEL_LEVEL_KEYS as AiModelLevel[])
  chatLevel?: AiModelLevel;

  @IsOptional()
  @IsIn(AI_MODEL_LEVEL_KEYS as AiModelLevel[])
  agentLevel?: AiModelLevel;

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(5)
  @ArrayUnique()
  @IsIn(AI_MODEL_LEVEL_KEYS as AiModelLevel[], { each: true })
  allowedLevels?: AiModelLevel[];

  @IsOptional()
  @IsIn(AI_DATA_RESIDENCIES as AiDataResidency[])
  dataResidency?: AiDataResidency;

  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;
}
