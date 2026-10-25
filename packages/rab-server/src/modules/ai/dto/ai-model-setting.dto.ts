import { IsString, Matches, MaxLength, MinLength } from 'class-validator';

/**
 * `PUT /rest/v1/ai/settings/models/:tier` — pin a model for one tier (Settings → AI, CEO only). The organisation, the
 * user and any status come from the verified session; a body carrying anything else is a 400 (forbidNonWhitelisted).
 * `modelId` is only a lookup key into the code catalogue (format-checked here and by the database CHECK, then required to
 * be an AVAILABLE model of that tier by the service).
 */
export class PinAiModelDto {
  @IsString()
  @Matches(/^[a-z0-9][a-z0-9._-]{0,99}$/, { message: 'modelId must be a catalogue model id' })
  modelId!: string;

  /** Required (D7): kept on the row and in the audit metadata. */
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;
}

/** `DELETE /rest/v1/ai/settings/models/:tier` — "Choose automatically" (removes the pin). */
export class UnpinAiModelDto {
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;
}
