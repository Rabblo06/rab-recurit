import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsObject, IsOptional, IsString, Matches, MaxLength, MinLength, ValidateNested } from 'class-validator';

export const ROLE_ICONS = ['shield', 'user', 'users', 'briefcase', 'calendar', 'building', 'eye', 'star', 'clipboard', 'key'] as const;
const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : value);

export class RoleObjectRuleDto {
  @IsIn(['staff', 'venue', 'shift'])
  object!: 'staff' | 'venue' | 'shift';

  /** inherit = follow the role's "All Objects" baseline; grant / deny override it for this object. */
  @IsIn(['inherit', 'grant', 'deny'])
  read!: 'inherit' | 'grant' | 'deny';

  /** Explicit field visibility; omitted fields use the server default. Keys and values are validated by the service. */
  @IsOptional()
  @IsObject()
  fields?: Record<string, 'visible' | 'hidden'>;

  /** Record-level filter tree; validated strictly by the service against the server's field/operator allowlist. */
  @IsOptional()
  @IsObject()
  recordFilter?: Record<string, unknown> | null;
}

/**
 * The whole editable definition of a custom workspace-member role, saved in ONE transaction (unlike a multi-call
 * save, a failure can never leave a role half-applied). Organisation, workspace, key and system flag are never
 * accepted from the client (`forbidNonWhitelisted`).
 */
export class RoleDefinitionDto {
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  @Matches(/\S/, { message: 'name must not be blank' })
  name!: string;

  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(500)
  description?: string | null;

  @IsOptional()
  @IsIn(ROLE_ICONS as unknown as string[])
  icon?: string | null;

  @IsBoolean()
  assignableToMembers!: boolean;

  /** "All Objects → See Records" baseline. */
  @IsBoolean()
  readAllObjects!: boolean;

  @IsArray()
  @ArrayMaxSize(3)
  @ValidateNested({ each: true })
  @Type(() => RoleObjectRuleDto)
  objects!: RoleObjectRuleDto[];
}
