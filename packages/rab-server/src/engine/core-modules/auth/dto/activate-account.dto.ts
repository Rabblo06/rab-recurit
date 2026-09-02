import { MAX_PASSWORD_LENGTH } from '@rab/shared';
import { IsString, MaxLength, MinLength } from 'class-validator';

/** Public — the raw token is the only identity the server trusts here; never a client-supplied userId/organisationId/workspaceId/role. */
export class ActivateAccountDto {
  @IsString()
  @MinLength(1)
  token!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(MAX_PASSWORD_LENGTH)
  newPassword!: string;
}
