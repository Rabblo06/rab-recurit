import { Type } from 'class-transformer';
import { Matches, IsArray, ValidateNested, ArrayMaxSize, ArrayMinSize, ArrayUnique, IsDateString, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';

export class RequestedStaffTimeDto {
  @IsUUID('4') staffProfileId!: string;
  @IsOptional()
  @IsInt()
  @Min(0)
  breakMinutes?: number | null;
  @Matches(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/)
  @IsDateString({ strict: true }) startsAt!: string;
  @Matches(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/)
  @IsDateString({ strict: true }) endsAt!: string;
}

/**
 * A Venue Manager's shift request — `venueId` is re-validated server-side
 * against the caller's own assigned-venue scope, never trusted as
 * authorization on its own. `staffProfileIds` names who the Venue Manager
 * wants (from their saved Users/team pool) — pure intent recorded on
 * `shift_request_staff`, re-validated server-side (real StaffProfile, ACTIVE
 * account, within this venue's own workspace) before being stored, and
 * re-validated AGAIN at approval time before any offer is actually sent
 * (see SchedulingService.submitRequest / OfferService.approveShiftRequest).
 */
export class SubmitShiftRequestDto {
  @IsUUID()
  venueId!: string;

  @IsUUID()
  jobRoleId!: string;

  @IsDateString()
  startsAt!: string;

  @IsDateString()
  endsAt!: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  staffRequired!: number;

  @IsUUID('4', { each: true })
  @ArrayUnique()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  staffProfileIds!: string[];

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  breakMinutes?: number;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => RequestedStaffTimeDto)
  staffAssignments?: RequestedStaffTimeDto[];

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string;
}
