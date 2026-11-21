import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsInt, IsOptional, IsUUID, Max, Min, ValidateNested } from 'class-validator';

import { WithAvailabilityAcknowledgementsDto } from '../../staff/dto/availability-acknowledgement.dto';

/** Most shifts one multi-shift send may name, and most (shift, staff) offers in total (checked in the service too). */
export const MULTI_SHIFT_SEND_MAX_SHIFTS = 50;
export const MULTI_SHIFT_SEND_MAX_OFFERS = 200;

export class ShiftRecipientsDto {
  @IsUUID()
  shiftId!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ArrayUnique()
  @IsUUID('4', { each: true })
  staffProfileIds!: string[];
}

/**
 * `POST /offers/send-to-shifts`: named action `sendOffersToShifts`. Many shifts, each with its own recipients, sent as
 * ONE all-or-nothing transaction. No status, kind, rate, time or organisation field exists here (forbidNonWhitelisted
 * → 400): every offer uses its shift's own times and pay rate snapshot, exactly as a single send does.
 */
export class SendOffersToShiftsDto extends WithAvailabilityAcknowledgementsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MULTI_SHIFT_SEND_MAX_SHIFTS)
  @ValidateNested({ each: true })
  @Type(() => ShiftRecipientsDto)
  items!: ShiftRecipientsDto[];

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(720)
  expiresInHours?: number;
}
