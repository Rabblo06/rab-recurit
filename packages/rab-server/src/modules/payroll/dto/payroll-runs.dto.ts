import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsInt, IsOptional, IsString, IsUUID, Length, Matches, Max, MaxLength, Min, ValidateNested,
} from 'class-validator';

const DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

export class CalendarPeriodDto {
  @Matches(DATE, { message: 'start must be YYYY-MM-DD' }) start!: string;
  @Matches(DATE, { message: 'end must be YYYY-MM-DD' }) end!: string;
  @Matches(DATE, { message: 'payday must be YYYY-MM-DD' }) payday!: string;
  @IsOptional() @IsString() @MaxLength(500) note?: string;
  @IsOptional() @IsBoolean() needsConfirmation?: boolean;
}

/** Agency payment calendar import. The organisation is the session's; never a body field. */
export class ImportCalendarDto {
  @Type(() => Number) @IsInt() @Min(2000) @Max(2100) year!: number;
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value)) @IsString() @Length(1, 200) source!: string;
  @IsOptional() @IsString() @MaxLength(2000) notes?: string;
  @IsOptional() @IsBoolean() dryRun?: boolean;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(60) @ValidateNested({ each: true }) @Type(() => CalendarPeriodDto) periods!: CalendarPeriodDto[];
}

export class PrepareRunDto {
  @IsUUID('all') periodId!: string;
}

export class PayslipNetDto {
  /** Copied from the provider's official payslip, or null to clear. Never computed by this system. */
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(100_000_000) netPence!: number | null;
}

export class MarkPaidDto {
  @IsOptional() @IsString() @MaxLength(120) paymentReference?: string;
}
