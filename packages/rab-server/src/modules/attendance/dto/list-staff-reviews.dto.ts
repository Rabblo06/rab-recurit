import { IsDateString, IsIn, IsOptional, IsUUID } from 'class-validator';

export const STAFF_REVIEW_RANGES = ['all', 'this_month', 'last_month', 'custom'] as const;
export type StaffReviewRange = (typeof STAFF_REVIEW_RANGES)[number];

/**
 * Staff Reviews tab filters (web, Initial Manager). `reviewer` narrows to one reviewing Venue Manager; `range` picks the
 * shift-date window in the organisation's timezone (`custom` uses inclusive `from` / `to` calendar dates). Unknown
 * fields are rejected (global `forbidNonWhitelisted`).
 */
export class ListStaffReviewsDto {
  @IsOptional()
  @IsUUID()
  reviewer?: string;

  @IsOptional()
  @IsIn(STAFF_REVIEW_RANGES)
  range?: StaffReviewRange;

  @IsOptional()
  @IsDateString({ strict: true })
  from?: string;

  @IsOptional()
  @IsDateString({ strict: true })
  to?: string;
}
