import { IsOptional, IsString, MaxLength } from 'class-validator';
import { PaginationDto } from '../../../engine/dto/pagination.dto';

/** Scope, status and shift times are server-derived, never query overrides. */
export class ListSelectableStaffDto extends PaginationDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  q?: string;
}
