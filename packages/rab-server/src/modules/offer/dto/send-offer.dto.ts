import { WithAvailabilityAcknowledgementsDto } from '../../staff/dto/availability-acknowledgement.dto';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';

export class SendOfferDto extends WithAvailabilityAcknowledgementsDto {
  @IsUUID()
  staffProfileId!: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(720)
  expiresInHours?: number;
}
