import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/** `POST /rest/v1/ai/conversations`. An optional title only; the owner, organisation and workspace come from the session. */
export class CreateAiConversationDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  title?: string;
}
