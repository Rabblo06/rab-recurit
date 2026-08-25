import { SmtpEncryption, SmtpEncryptionType } from '@rab/shared';
import { IsEmail, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';

/** `password` omitted means "keep the existing stored password" — never returned to the client, only a `hasPassword` boolean is. */
export class UpdateSmtpConfigDto {
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
  @MinLength(1)
  password?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  fromName?: string;

  @IsEmail()
  fromEmail!: string;
}
