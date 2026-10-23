import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';

/** `GET /rest/v1/timeline/<entity>/:id` — keyset pagination only (no offset scans over a growing audit log). */
export class TimelineQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  /** Opaque cursor from a previous page's `nextCursor`. Validated strictly by TimelineService (400 when malformed). */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  @Matches(/^[A-Za-z0-9_-]+$/)
  cursor?: string;
}
