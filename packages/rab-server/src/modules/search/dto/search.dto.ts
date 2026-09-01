import { IsInt, IsOptional, IsString, Max, Min, MinLength } from 'class-validator';
import { Type } from 'class-transformer';

export class SearchDto {
  @IsString()
  @MinLength(1)
  q!: string;

  /** Per resource-type cap — never a way to request an unbounded scan. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(20)
  limit?: number;
}
