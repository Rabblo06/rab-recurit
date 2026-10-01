import { RequestedStaffTimeDto } from '../../scheduling/dto/submit-shift-request.dto';
import { Type } from 'class-transformer';
import { IsArray, ArrayUnique, ValidateNested, ArrayMaxSize, ArrayMinSize, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';

export class SendBulkOfferDto {
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
}
