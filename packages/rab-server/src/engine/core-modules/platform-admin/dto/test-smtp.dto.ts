import { SmtpEncryption, SmtpEncryptionType } from '@rab/shared';
import { IsEmail, IsIn, IsInt, IsOptional, IsString, Max, Min, MinLength } from 'class-validator';

/**
 * Tested against UNSAVED form values, so an admin can verify a connection
 * before persisting it — `password` optional here too, meaning "use the
 * already-stored password" (re-testing an unchanged credential shouldn't
 * require re-entering it).
 */
export class TestSmtpDto {
  @IsString()
  @MinLength(1)
  host!: string;

  @IsInt()
  @Min(1)
  @Max(65535)
  port!: number;

  @IsIn(Object.values(SmtpEncryption))
  encryption!: SmtpEncryptionType;

  @IsOptional()
  @IsString()
  username?: string;

  @IsOptional()
  @IsString()
  password?: string;

  /** Only present for "Send Test Email" — omitted for a plain connection test. */
  @IsOptional()
  @IsEmail()
  sendTo?: string;
}
