import { IsOptional, IsString, MaxLength } from 'class-validator';

export class DeclineShiftRequestDto {
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reason?: string;
}
