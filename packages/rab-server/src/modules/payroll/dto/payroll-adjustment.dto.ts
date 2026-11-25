import { PayrollAdjustmentKind, PayrollAdjustmentKindType, PayrollAdjustmentStatus, PayrollAdjustmentStatusType } from '@rab/shared';
import { Transform, Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, IsUUID, Length, Max, Min, NotEquals } from 'class-validator';

import { PaginationDto } from '../../../engine/dto/pagination.dto';
import {
  PAYROLL_ADJUSTMENT_MAX_PENCE,
  PAYROLL_ADJUSTMENT_REASON_MAX,
  PAYROLL_ADJUSTMENT_REASON_MIN,
} from '../../../database/typeorm/core/payroll-adjustment-sql';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

/**
 * Owner decision 3 (payroll adjustments). Every mutation is a named action (add a correction / bonus / expense, approve,
 * reject); none accepts a status, an organisation, a workspace, a creator or a staff user id. `forbidNonWhitelisted`
 * turns any such extra field into a 400.
 */
export class AddPayrollCorrectionDto {
  /** The ORIGINAL approved payroll record this corrects. The staff member is taken from that record, never the body. */
  @IsUUID('all') payrollRecordId!: string;

  /** Plus or minus, integer pence, never zero. A negative correction (an overpayment) is the only reduction. */
  @Type(() => Number) @IsInt() @NotEquals(0) @Min(-PAYROLL_ADJUSTMENT_MAX_PENCE) @Max(PAYROLL_ADJUSTMENT_MAX_PENCE)
  amountPence!: number;

  @Transform(trim) @IsString() @Length(PAYROLL_ADJUSTMENT_REASON_MIN, PAYROLL_ADJUSTMENT_REASON_MAX) reason!: string;
}

/** A bonus or an expense: positive integer pence for one staff member of the caller's workspace. */
export class AddPayrollAdditionDto {
  @IsUUID('all') staffProfileId!: string;

  @Type(() => Number) @IsInt() @Min(1) @Max(PAYROLL_ADJUSTMENT_MAX_PENCE) amountPence!: number;

  @Transform(trim) @IsString() @Length(PAYROLL_ADJUSTMENT_REASON_MIN, PAYROLL_ADJUSTMENT_REASON_MAX) reason!: string;
}

export class RejectPayrollAdjustmentDto {
  @Transform(trim) @IsString() @Length(PAYROLL_ADJUSTMENT_REASON_MIN, PAYROLL_ADJUSTMENT_REASON_MAX) reason!: string;
}

/** READ filters only. */
export class ListPayrollAdjustmentsDto extends PaginationDto {
  @IsOptional() @IsIn(Object.values(PayrollAdjustmentStatus)) status?: PayrollAdjustmentStatusType;
  @IsOptional() @IsIn(Object.values(PayrollAdjustmentKind)) kind?: PayrollAdjustmentKindType;
  @IsOptional() @IsUUID('all') staffProfileId?: string;
}
