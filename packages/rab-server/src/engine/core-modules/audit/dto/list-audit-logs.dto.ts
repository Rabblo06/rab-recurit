import { Type } from 'class-transformer';
import { IsDateString, IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

import { AuditAction } from '../audit.service';

export const AUDIT_LOG_SORT_FIELDS = ['createdAt'] as const;

export class ListAuditLogsDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  limit?: number;

  @IsOptional()
  @IsString()
  entityType?: string;

  @IsOptional()
  @IsString()
  entityId?: string;

  /** Real AuditAction values only (58 today) — never invented, and never an
   * arbitrary actor filter: `list()` is hardcoded to the caller's own
   * actions (see its own doc comment) and this DTO does not add a way
   * around that. */
  @IsOptional()
  @IsIn(Object.values(AuditAction))
  action?: string;

  @IsOptional()
  @IsDateString()
  createdAtFrom?: string;

  @IsOptional()
  @IsDateString()
  createdAtTo?: string;

  @IsOptional()
  @IsIn(AUDIT_LOG_SORT_FIELDS)
  sort?: (typeof AUDIT_LOG_SORT_FIELDS)[number];

  @IsOptional()
  @IsIn(['asc', 'desc'])
  direction?: 'asc' | 'desc';
}
