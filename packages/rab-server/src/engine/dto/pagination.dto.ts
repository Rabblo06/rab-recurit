import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

/**
 * Shared by every list endpoint that doesn't otherwise cap its result set
 * (`venues`, `managers`, `staff`, `shifts`, `offers`, `offers/mine` — audit
 * logs already had their own cap, see `ListAuditLogsDto`). `limit` defaults
 * to 500 when omitted — high enough that no org's current table view
 * silently loses rows it used to see, but no client can request an
 * unbounded scan of a table that grows for years (`?limit=10000000`).
 */
export class PaginationDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000)
  limit?: number;
}

export function paginationSkipTake(dto: PaginationDto): { skip: number; take: number } {
  const take = dto.limit ?? 500;
  const page = dto.page ?? 1;
  return { skip: (page - 1) * take, take };
}
