import { IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Account security step 1 (P6): start an SSO re-authentication. `returnTo` is only a HINT: the server maps it onto a
 * fixed allowlist of same-origin paths (`SSO_REAUTH_RETURN_PATHS`) and ignores anything else — never an open redirect.
 */
export class SsoReauthStartDto {
  @IsOptional()
  @IsString()
  @MaxLength(512)
  returnTo?: string;
}
