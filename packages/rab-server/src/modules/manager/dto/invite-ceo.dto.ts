import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

/**
 * Settings → Members → Add (platform administrator): the CEO's email ONLY. Deliberately no organisation name, no CEO
 * name, no role and no organisationId — the CEO supplies their own details when accepting, the role is always CEO, and
 * `forbidNonWhitelisted` turns any other field into a 400. The address itself is validated by the service.
 */
export class InviteCeoDto {
  @IsString()
  @MaxLength(320)
  email!: string;
}

export class ListCeoInvitationsDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
