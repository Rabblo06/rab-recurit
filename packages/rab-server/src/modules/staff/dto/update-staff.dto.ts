import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, ArrayUnique, IsArray, IsDateString, IsIn, IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';
import { IsRealisticBirthDate } from '../../../engine/decorators/is-realistic-birth-date.decorator';

const PHONE_PATTERN = /^[+]?[0-9\s().-]{7,20}$/;

/** Same suggestion lists as CreateStaffDto — kept in sync, not re-derived. */
const EMPLOYMENT_TYPES = ['Full-time', 'Part-time', 'Temporary', 'Casual', 'Contract'] as const;
const SHIFT_TIMES = ['Morning', 'Afternoon', 'Evening', 'Night', 'Flexible'] as const;
const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] as const;

/**
 * Employment status is deliberately absent here — it changes via the named
 * `deactivate`/`reactivate` actions, never a raw field set (CLAUDE.md: no
 * raw status from a client).
 */
export class UpdateStaffDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  firstName?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  lastName?: string;

  @IsOptional()
  @Matches(PHONE_PATTERN, { message: 'phone must be a valid international phone number.' })
  phone?: string;

  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(1)
  staffRef?: string;

  @IsOptional()
  @IsDateString()
  startDate?: string;

  @IsOptional()
  @IsDateString()
  @IsRealisticBirthDate()
  dateOfBirth?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  defaultPayRatePence?: number;

  /** Same field the Create Staff form's Employment section writes — one source of truth, see StaffProfile.jobRoleId's own doc comment. */
  @IsOptional()
  @IsUUID()
  jobRoleId?: string;

  @IsOptional()
  @IsString()
  emergencyContactName?: string;

  @IsOptional()
  @IsString()
  emergencyContactRelationship?: string;

  @IsOptional()
  @Matches(PHONE_PATTERN, { message: 'emergencyContactPhone must be a valid international phone number.' })
  emergencyContactPhone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  preferredName?: string;

  @IsOptional()
  @IsIn(EMPLOYMENT_TYPES)
  employmentType?: string;

  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(200)
  address?: string;

  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(100)
  city?: string;

  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(20)
  postcode?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  otherSkills?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(60)
  yearsExperience?: number;

  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsIn(WEEKDAYS, { each: true })
  availableDays?: string[];

  @IsOptional()
  @IsIn(SHIFT_TIMES)
  preferredShiftTimes?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(168)
  maxHoursPerWeek?: number;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  rightToWorkStatus?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  documentType?: string;

  @IsOptional()
  @IsDateString()
  expiryDate?: string;

  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(20)
  @MaxLength(50, { each: true })
  languages?: string[];

  /** Profile/static work information — distinct from `user_note` (the chronological manager-notes tab). Maps to the existing `StaffProfile.notes` column. */
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}
