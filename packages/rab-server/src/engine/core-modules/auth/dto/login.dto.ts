import { MAX_PASSWORD_LENGTH } from '@rab/shared';
import { Transform } from 'class-transformer';
import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';

export class LoginDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsEmail()
  email!: string;

  // MinLength(1) only, deliberately not the full password policy —
  // login checks an *existing* hash, which may predate today's policy.
  // MaxLength caps argon2id verify cost on pathological input, including
  // against a nonexistent email (the dummy-hash path still runs verify()).
  @IsString()
  @MinLength(1)
  @MaxLength(MAX_PASSWORD_LENGTH)
  password!: string;
}
