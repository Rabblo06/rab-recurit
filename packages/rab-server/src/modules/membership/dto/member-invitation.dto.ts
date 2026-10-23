import { MAX_PASSWORD_LENGTH, MEMBER_INVITATION_MAX_EMAILS_PER_REQUEST, MemberInvitationStatus, MemberInvitationStatusType } from '@rab/shared';
import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';

/**
 * Send one or more email-first invitations. Deliberately NO name fields and NO organisationId / workspaceId /
 * managerId: the organisation and workspace come from the verified session, and the recipient supplies their own
 * name when accepting. `roleId` is a REQUEST the server checks against what this caller may assign — never an
 * authority. Individual addresses are validated per recipient by the service so one bad address does not reject
 * the whole batch (each gets its own outcome).
 */
export class SendMemberInvitationsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MEMBER_INVITATION_MAX_EMAILS_PER_REQUEST)
  @IsString({ each: true })
  @MaxLength(320, { each: true })
  emails!: string[];

  /** A custom workspace-member role of the caller's own workspace; anything else is a 404 from the service. */
  @IsUUID()
  roleId!: string;
}

export class ListMemberInvitationsDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;

  @IsOptional()
  @IsIn(Object.values(MemberInvitationStatus))
  status?: MemberInvitationStatusType;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : value);

/** Public: look up what an invitation link is for, before the recipient fills in their details. */
export class ResolveMemberInvitationDto {
  @IsString()
  @MinLength(20)
  @MaxLength(128)
  token!: string;
}

/**
 * Public: accept an invitation. The RECIPIENT supplies their own first and last name and password here — the
 * inviting administrator never does. Names are trimmed and must contain at least one non-space character.
 */
export class AcceptMemberInvitationDto {
  @IsString()
  @MinLength(20)
  @MaxLength(128)
  token!: string;

  @Transform(trim)
  @IsString()
  @MinLength(1, { message: 'Enter your first name.' })
  @MaxLength(100)
  @Matches(/\S/, { message: 'Enter your first name.' })
  firstName!: string;

  @Transform(trim)
  @IsString()
  @MinLength(1, { message: 'Enter your last name.' })
  @MaxLength(100)
  @Matches(/\S/, { message: 'Enter your last name.' })
  lastName!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(MAX_PASSWORD_LENGTH)
  newPassword!: string;

  /**
   * Owner correction 2026-10-23: required for a platform administrator's CEO (organisation) invitation — the CEO names
   * their own organisation here. Refused (400) for a workspace-member invitation.
   */
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(1, { message: 'Enter your organisation name.' })
  @MaxLength(120)
  @Matches(/\S/, { message: 'Enter your organisation name.' })
  organisationName?: string;
}
