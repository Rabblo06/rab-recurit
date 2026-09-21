import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, ArrayUnique, IsDateString, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';

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
  @Type(() => Number)
  @IsInt()
  @Min(0)
  payRatePence?: number;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string;
}
