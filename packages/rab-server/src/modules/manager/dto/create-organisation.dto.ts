import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';

/**
 * P2.9B — Platform-Super-Admin-only. `organisationId`/`role` are never accepted here (there is no
 * such field at all, so `forbidNonWhitelisted` 400s any attempt) — the new organisation's id is
 * always server-generated, and the invited recipient's role is always fixed to CEO by
 * `OrganisationOnboardingService`, never client-supplied.
 */
export class CreateOrganisationDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name!: string;

  @IsEmail()
  ceoEmail!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(100)
  ceoFirstName!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(100)
  ceoLastName!: string;
}
