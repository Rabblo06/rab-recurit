import { IsBoolean, IsOptional } from 'class-validator';

/** Settings -> Security -> Authentication (P1C.1B). Every field optional — a partial patch, same shape as UpdateWorkspaceDto. */
export class UpdateAuthProvidersDto {
  @IsOptional()
  @IsBoolean()
  passwordAuthEnabled?: boolean;

  @IsOptional()
  @IsBoolean()
  googleAuthEnabled?: boolean;

  @IsOptional()
  @IsBoolean()
  microsoftAuthEnabled?: boolean;
}
