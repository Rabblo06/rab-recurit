import { WithAvailabilityAcknowledgementsDto } from '../../staff/dto/availability-acknowledgement.dto';
import { Type } from 'class-transformer';
import { StaffOfferAssignmentDto } from './staff-offer-assignment.dto';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsDateString,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  IsArray,
  ArrayUnique,
  ValidateNested,
} from 'class-validator';

export class CreateShiftAndSendDto extends WithAvailabilityAcknowledgementsDto {
  @IsUUID()
  venueId!: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  requiredCount?: number;

  @IsUUID()
  jobRoleId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  address?: string;

  @IsDateString()
  startsAt!: string;

  @IsDateString()
  endsAt!: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  breakMinutes?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  payRatePence?: number;

  @IsOptional()
  @IsString()
  notes?: string;

  @ArrayUnique()
  @IsUUID('4', { each: true })
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  staffProfileIds!: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => StaffOfferAssignmentDto)
  staffAssignments?: StaffOfferAssignmentDto[];

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(720)
  expiresInHours?: number;
}
