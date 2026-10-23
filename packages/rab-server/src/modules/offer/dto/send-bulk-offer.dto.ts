import { WithAvailabilityAcknowledgementsDto } from '../../staff/dto/availability-acknowledgement.dto';
import { RequestedStaffTimeDto } from '../../scheduling/dto/submit-shift-request.dto';
import { Type } from 'class-transformer';
import { IsArray, ArrayUnique, ValidateNested, ArrayMaxSize, ArrayMinSize, IsIn, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';

/** The send form's intent. Never an offer kind or a status: the server decides `replacement` vs `standby` itself. */
export const SEND_OFFER_MODES = ['standard', 'replacement'] as const;
export type SendOfferMode = (typeof SEND_OFFER_MODES)[number];

export class SendBulkOfferDto extends WithAvailabilityAcknowledgementsDto {
  @ArrayUnique()
  @IsUUID('4', { each: true })
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  staffProfileIds!: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => RequestedStaffTimeDto)
  staffAssignments?: RequestedStaffTimeDto[];

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(720)
  expiresInHours?: number;

  /**
   * `replacement` = the "Send replacement offer" form on an EXISTING shift (opened from that shift's pipeline). Same
   * endpoint, same shift id, never a new shift. Omitted / `standard` = the unchanged "Send offers" behaviour.
   */
  @IsOptional()
  @IsIn(SEND_OFFER_MODES)
  mode?: SendOfferMode;
}
