import { PermissionFlag, PermissionFlagType } from '@rab/shared';
import { ArrayUnique, IsArray, IsIn, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

export class UpdateRoleDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  @Matches(/\S/, { message: 'name must not be blank' })
  name?: string;

  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsIn(Object.values(PermissionFlag), { each: true })
  permissionKeys?: PermissionFlagType[];
}
