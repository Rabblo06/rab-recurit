import { MAX_PASSWORD_LENGTH, ManagerType, ManagerTypeType, MIN_PASSWORD_LENGTH } from '@rab/shared';
import { Transform } from 'class-transformer';
import { IsEmail, IsEnum, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class CreateManagerDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(1)
  firstName!: string;

  @IsString()
  @MinLength(1)
  lastName!: string;

  @IsOptional()
  @IsString()
  phone?: string;

  @IsEnum(ManagerType)
  type!: ManagerTypeType;

  @IsOptional()
  @IsString()
  jobTitle?: string;

  /** Admin-supplied temp password; optional, re-validated server-side. See CreateStaffDto. */
  @IsOptional()
  @IsString()
  @MinLength(MIN_PASSWORD_LENGTH)
  @MaxLength(MAX_PASSWORD_LENGTH)
  temporaryPassword?: string;
}
