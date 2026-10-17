import { Transform } from 'class-transformer';
import { IsEmail, IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * CF-04: an administrator's change of another account's sign-in email. For an ACTIVE account the actor must confirm their
 * own current password (step-up), and the change only takes effect once the new address confirms it.
 */
export class ChangeEmailDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsEmail()
  email!: string;

  @IsOptional()
  @IsString()
  @MaxLength(1024)
  currentPassword?: string;
}

/** CF-04: redemption of the single-use token mailed to the new address. */
export class ConfirmEmailChangeDto {
  @IsString()
  @MaxLength(256)
  token!: string;
}
