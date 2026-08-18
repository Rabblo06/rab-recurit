import { ManagerType, ManagerTypeType, MIN_PASSWORD_LENGTH } from '@rab/shared';
import { IsEmail, IsEnum, IsOptional, IsString, MinLength } from 'class-validator';

export class CreateManagerDto {
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
  temporaryPassword?: string;
}
