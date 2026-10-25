import { Type } from 'class-transformer';
import { IsBoolean, IsInt, IsISO8601, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';

/** `PUT /rest/v1/admin/ai/organisations/:organisationId/setting` — the per-organisation AI switch (platform admin only). */
export class UpdateAiOrganisationSettingDto {
  @IsBoolean()
  enabled!: boolean;

  /** Optional reason, kept on the row and in the audit metadata. */
  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason?: string;
}

/** `GET /rest/v1/admin/ai/usage?from=YYYY-MM-DD&to=YYYY-MM-DD&limit=` — UTC days, at most 93 days (the database refuses more). */
export class AiUsageQueryDto {
  @IsISO8601({ strict: true })
  from!: string;

  @IsISO8601({ strict: true })
  to!: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}
