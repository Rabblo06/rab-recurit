import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class CreateManagerWorkspaceDto {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  /** Never trusted as final — re-normalized and re-validated server-side. See SubdomainService. */
  @IsString()
  @MinLength(1)
  @MaxLength(63)
  subdomain!: string;
}
