import { PayrollRecordStatus, PayrollRecordStatusType } from '@rab/shared';
import { Transform } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsIn, IsOptional, IsString, IsUUID, Length, Matches } from 'class-validator';

import { PaginationDto } from '../../../engine/dto/pagination.dto';

/** A READ filter only. No mutation in this module accepts a status: approve / reject are named actions. */
export class ListPayrollRecordsDto extends PaginationDto {
  @IsOptional()
  @IsIn(Object.values(PayrollRecordStatus))
  status?: PayrollRecordStatusType;
}

export class RejectPayrollRecordDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @Length(3, 500)
  reason!: string;
}

/** Bulk approve: each id validated and authorised individually; ineligible ids are reported back, never approved. */
export const BULK_APPROVE_MAX = 100;

export class BulkApprovePayrollDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(BULK_APPROVE_MAX)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  ids!: string[];
}

/** `GET /payroll/period?month=YYYY-MM` — a calendar month in the organisation's timezone. */
export class PayrollPeriodQueryDto {
  @IsString()
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, { message: 'month must be YYYY-MM' })
  month!: string;
}
