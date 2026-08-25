import { PermissionFlag, PermissionFlagType } from '@rab/shared';
import { ArrayUnique, IsArray, IsIn, IsString, MinLength } from 'class-validator';

export class CreateRoleDto {
  @IsString()
  @MinLength(1)
  name!: string;

  @IsArray()
  @ArrayUnique()
  @IsIn(Object.values(PermissionFlag), { each: true })
  permissionKeys!: PermissionFlagType[];
}
