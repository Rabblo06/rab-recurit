import { Transform } from 'class-transformer';
import { IsEmail, IsOptional, IsString, MinLength } from 'class-validator';

/**
 * Normal Manager flow (VENUE_MANAGER_CREATE). Deliberately has NO workspace, organisation, type or schema field:
 * `forbidNonWhitelisted` rejects any of them with 400, and the workspace always comes from the caller's session.
 */
export class CreateVenueManagerDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(1)
  firstName!: string;

  @IsString()
  @MinLength(1)
  lastName!: string;

  @IsOptional()
  @IsString()
  phone?: string;

  @IsOptional()
  @IsString()
  jobTitle?: string;
}
