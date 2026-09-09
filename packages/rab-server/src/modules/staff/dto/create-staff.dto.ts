import { MAX_PASSWORD_LENGTH } from '@rab/shared';
import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, ArrayUnique, IsArray, IsDateString, IsEmail, IsIn, IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';
import { IsRealisticBirthDate } from '../../../engine/decorators/is-realistic-birth-date.decorator';

const PHONE_PATTERN = /^[+]?[0-9\s().-]{7,20}$/;

/** A suggestion list, not an authoritative backend enum — no such enum exists elsewhere in this schema. */
const EMPLOYMENT_TYPES = ['Full-time', 'Part-time', 'Temporary', 'Casual', 'Contract'] as const;
const SHIFT_TIMES = ['Morning', 'Afternoon', 'Evening', 'Night', 'Flexible'] as const;
const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] as const;

/**
 * `organisationId` is deliberately absent — it comes from the verified
 * session, never the client (CLAUDE.md). `forbidNonWhitelisted` (main.ts)
 * turns a body that includes it into a 400, not a silent override.
 *
 * MODEL B (deliberate, not a workaround): a Manager creates the minimum
 * identity/employment record — firstName, lastName, email, staffRef —
 * everything else is a profile-completion field that stays nullable at
 * this layer. There is no employee-facing "finish your profile" flow
 * built yet (web or mobile) to hand these off to, so calling this "the
 * employee completes the rest later" would overstate what exists — the
 * honest framing is "the API accepts a minimal record; nothing prevents a
 * fuller one." The Create Staff *screen* separately marks Mobile number
 * and Emergency Contact required as its own UX/product decision (verified
 * against the real API contract, not silently diverging from it) —
 * confirmed by running the full suite that dozens of existing integration
 * tests across unrelated features (invitation lifecycle, activation, RLS)
 * construct a Staff via exactly this minimal shape as a plain setup
 * fixture, not as the thing under test. Hard-requiring these fields here
 * would be a real breaking API-contract change with a 50+-test blast
 * radius for a UI-layer decision, not a fix to a bug.
 */
export class CreateStaffDto {
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
  @Matches(PHONE_PATTERN, { message: 'phone must be a valid international phone number.' })
  phone?: string;

  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(1)
  staffRef!: string;

  @IsOptional()
  @IsDateString()
  startDate?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  defaultPayRatePence?: number;

  @IsOptional()
  @IsDateString()
  @IsRealisticBirthDate()
  dateOfBirth?: string;

  /** Reuses the existing `JobRole` entity (built for Shift creation) — never a second, free-text "job role" concept. Optional: not every org has set one up yet. */
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

  /**
   * Optional, not required — matching this DTO's own Model B precedent
   * above (required-ness lives in the Create Staff screen, not the API
   * contract, so the 50+ existing tests/integrations that construct a
   * minimal Staff payload stay unaffected). Shape-only validation here;
   * `checkPasswordStrength` runs in `StaffService.create()`, matching
   * `ResetPasswordDto`'s identical precedent — never a custom decorator.
   * Hashed into `User.temporaryPasswordHash`, a column AuthService.login()
   * never reads — see that column's own comment for why it must never be
   * `passwordHash` itself.
   */
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(MAX_PASSWORD_LENGTH)
  temporaryPassword?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  preferredName?: string;

  /** Suggestion list enforced here only — no authoritative backend enum exists for this concept (distinct from `EmploymentStatus`, which is a compliance lifecycle state, not this). */
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

  /** Free text, comma-separated — no tag-input component exists in this codebase; see StaffProfile.otherSkills's own doc comment. */
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

  /** Free text, deliberately not a fixed enum — see StaffProfile.rightToWorkStatus's own doc comment for the compliance reasoning. */
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

  /** Open-ended (language names aren't a fixed enum, unlike weekdays) — bounded by count and per-item length only. */
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(20)
  @MaxLength(50, { each: true })
  languages?: string[];

  /**
   * Profile/static work information — distinct from `user_note` (the
   * chronological manager-notes tab). Maps to `StaffProfile.notes`, an
   * existing column that predates this field's own UI wiring.
   */
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}
