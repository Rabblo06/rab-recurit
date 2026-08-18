import { IsOptional, IsString } from 'class-validator';

export class DeclineOfferDto {
  @IsOptional()
  @IsString()
  reason?: string;
}
