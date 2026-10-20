import { IsIn } from 'class-validator';

import { PaginationDto } from '../../../engine/dto/pagination.dto';

export const REPORT_BUCKETS = ['current', 'history'] as const;
export type ReportBucket = (typeof REPORT_BUCKETS)[number];

export class ListShiftReportsDto extends PaginationDto {
  @IsIn(REPORT_BUCKETS)
  bucket!: ReportBucket;
}
