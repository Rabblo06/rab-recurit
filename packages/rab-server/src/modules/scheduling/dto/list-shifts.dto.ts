import { IsDateString, IsOptional } from 'class-validator';

import { PaginationDto } from '../../../engine/dto/pagination.dto';

export class ListShiftsDto extends PaginationDto {
  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;
}
