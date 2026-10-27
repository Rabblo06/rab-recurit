import {
  AI_ASSISTANT_COLOURS,
  AI_ASSISTANT_FACES,
  AI_ASSISTANT_PRESET_KEYS,
  AI_ASSISTANT_SHAPES,
  AiAssistantColour,
  AiAssistantFace,
  AiAssistantPreset,
  AiAssistantShape,
} from '@rab/shared';
import { IsBoolean, IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/**
 * `PUT /rest/v1/ai/settings/assistant` (C1 / CD-3; CEO only). Either `preset` alone (optionally with `animate`), or a
 * custom profile carrying all of name / shape / colour / face. The service enforces that combination and the name rules
 * (no control, bidi or zero-width characters). Any other key is a 400 (forbidNonWhitelisted).
 */
export class UpdateAiAssistantDto {
  @IsOptional()
  @IsIn(AI_ASSISTANT_PRESET_KEYS as AiAssistantPreset[])
  preset?: AiAssistantPreset;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(24)
  name?: string;

  @IsOptional()
  @IsIn(AI_ASSISTANT_SHAPES as readonly string[] as AiAssistantShape[])
  shape?: AiAssistantShape;

  @IsOptional()
  @IsIn(AI_ASSISTANT_COLOURS as readonly string[] as AiAssistantColour[])
  colour?: AiAssistantColour;

  @IsOptional()
  @IsIn(AI_ASSISTANT_FACES as readonly string[] as AiAssistantFace[])
  face?: AiAssistantFace;

  @IsOptional()
  @IsBoolean()
  animate?: boolean;
}
