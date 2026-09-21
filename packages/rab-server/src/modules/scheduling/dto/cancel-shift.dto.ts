import { IsOptional, IsString, MaxLength } from 'class-validator';

export class CancelShiftDto {
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reason?: string;
}
