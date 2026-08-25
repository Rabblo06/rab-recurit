import { PermissionFlag, PermissionFlagType } from '@rab/shared';
import { ArrayUnique, IsArray, IsIn, IsOptional, IsString, MinLength } from 'class-validator';

export class UpdateRoleDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  name?: string;

  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsIn(Object.values(PermissionFlag), { each: true })
  permissionKeys?: PermissionFlagType[];
}
