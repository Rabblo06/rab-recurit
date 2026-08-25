import { IsOptional, IsString, MinLength } from 'class-validator';

/** slug/subdomain changes go through UpdateSubdomainDto (a separate, more deliberate action) — not folded in here. */
export class UpdateWorkspaceDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  name?: string;

  @IsOptional()
  @IsString()
  timezone?: string;
}
