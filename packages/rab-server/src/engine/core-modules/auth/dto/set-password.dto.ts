import { MAX_PASSWORD_LENGTH } from '@rab/shared';
import { IsString, MaxLength, MinLength } from 'class-validator';

export class SetPasswordDto {
  @IsString()
  @MinLength(1)
  @MaxLength(MAX_PASSWORD_LENGTH)
  newPassword!: string;
}
