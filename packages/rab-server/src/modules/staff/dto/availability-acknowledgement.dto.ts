import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsOptional, IsUUID, Matches, ValidateNested } from 'class-validator';

/**
 * "Send anyway" for one staff member: the London calendar dates (YYYY-MM-DD) the sender saw flagged as outside that staff
 * member's declared availability. The server recomputes conflicts at dispatch and accepts only if every conflicting date is
 * listed here — an acknowledgement for last week's dates never covers a shift that has since moved. It authorises nothing on
 * its own: every existing send/approve permission, ownership and eligibility check still applies.
 */
export class AvailabilityAcknowledgementDto {
  @IsUUID()
  staffProfileId!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(31)
  @ArrayUnique()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { each: true })
  dates!: string[];
}

/** Mixed into every offer-dispatching DTO (send, bulk, create-and-send, approve, replacement, Venue Manager request). */
export class WithAvailabilityAcknowledgementsDto {
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => AvailabilityAcknowledgementDto)
  acknowledgedAvailabilityConflicts?: AvailabilityAcknowledgementDto[];
}
