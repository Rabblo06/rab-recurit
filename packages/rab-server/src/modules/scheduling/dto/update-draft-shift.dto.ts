import { Type } from 'class-transformer';
import { IsDateString, IsInt, IsOptional, IsString, Min } from 'class-validator';

/**
 * Named action `updateDraftShift` (`PATCH /rest/v1/shifts/:id/draft`, PHASE5_TWENTY_PLAN D2): the five schedule fields of
 * a DRAFT shift, nothing else. There is deliberately no `status`, no `payRatePence` / `chargeRatePence`, no venue or job
 * role and no tenant field: `forbidNonWhitelisted` turns any of them into a 400. The pay rate snapshotted when the draft
 * was created is NOT re-resolved by an edit (flagged assumption D2). Omitted = unchanged; `notes: null` clears the notes.
 */
export class UpdateDraftShiftDto {
  @IsOptional()
  @IsDateString()
  startsAt?: string;

  @IsOptional()
  @IsDateString()
  endsAt?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  breakMinutes?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  requiredCount?: number;

  @IsOptional()
  @IsString()
  notes?: string | null;
}

/** The only keys `updateDraftTx` reads (explicit mapping, never a spread of the client object). */
export const UPDATE_DRAFT_SHIFT_FIELDS = ['startsAt', 'endsAt', 'breakMinutes', 'requiredCount', 'notes'] as const;
