import { BadRequestException } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';

import { KEYSET_CURSOR_MAX_LENGTH } from './keyset-cursor';

/** Page size when a request names none (Phase C1, contract §1; was 500 before C1). */
export const DEFAULT_PAGE_LIMIT = 50;
/** Largest page any request may ask for; above it is a 400, never a silent clamp (Phase C1; was 1000 before C1). */
export const MAX_PAGE_LIMIT = 200;

/**
 * Shared by every list endpoint that doesn't otherwise cap its result set
 * (`venues`, `managers`, `staff`, `shifts`, `offers`, `offers/mine` — audit
 * logs already had their own cap, see `ListAuditLogsDto`). `limit` defaults
 * to `DEFAULT_PAGE_LIMIT` (50) when omitted and may not exceed
 * `MAX_PAGE_LIMIT` (200): no client can request an unbounded scan of a table
 * that grows for years (`?limit=10000000` is a 400). Callers that need every
 * row walk pages (`total` is returned wherever it was before) — nothing is
 * silently truncated. Two shipped mobile endpoints keep their pre-C1 default
 * of 500 when called with no paging parameter at all; see
 * `LEGACY_UNPAGED_LIMIT`.
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
  @Max(MAX_PAGE_LIMIT)
  limit?: number;
}

/**
 * `PaginationDto` + the opaque keyset cursor (Phase C1, contract §3), for the endpoints that implement cursor paging.
 * Kept separate from `PaginationDto` on purpose: an endpoint that does NOT implement it must reject `cursor` (400 via
 * `forbidNonWhitelisted`), never silently ignore it and hand a cursor-walking client page one forever. The shape here
 * is only a first gate; the service decodes it strictly (`decodeKeysetCursor`), so a direct service call is checked too.
 */
export class KeysetPaginationDto extends PaginationDto {
  @IsOptional()
  @IsString()
  @MaxLength(KEYSET_CURSOR_MAX_LENGTH)
  @Matches(/^[A-Za-z0-9_-]+$/)
  cursor?: string;
}

export function paginationSkipTake(dto: PaginationDto): { skip: number; take: number } {
  const take = dto.limit ?? DEFAULT_PAGE_LIMIT;
  const page = dto.page ?? 1;
  return { skip: (page - 1) * take, take };
}

/**
 * Offset + size for a request that may carry a keyset cursor. A cursor already says where the page starts, so it may
 * not be combined with a later offset page (`page > 1` -> 400 rather than guessing which one wins); `page=1` is the
 * same as no page. Without a cursor this is exactly `paginationSkipTake`.
 */
export function keysetSkipTake(dto: KeysetPaginationDto): { skip: number; take: number } {
  if (!dto.cursor) return paginationSkipTake(dto);
  if ((dto.page ?? 1) > 1) throw new BadRequestException('Use either page or cursor, not both.');
  return { skip: 0, take: dto.limit ?? DEFAULT_PAGE_LIMIT };
}

/**
 * LEGACY (installed staff apps, contract §2): `GET /offers/mine` and `GET /attendance/me/history` called with NO
 * `limit`, `cursor` or `scope` keep their pre-C1 behaviour exactly — a bare array of up to 500 rows in the same order.
 * Shipped Flutter/iOS builds call them that way and cannot be updated in place, so this value must never follow
 * `DEFAULT_PAGE_LIMIT`. Remove only once no supported app build calls either endpoint without paging parameters.
 */
export const LEGACY_UNPAGED_LIMIT = 500;

/**
 * True for the LEGACY unpaged call of `GET /offers/mine` / `GET /attendance/me/history` (contract §2): none of `limit`,
 * `cursor`, `scope` present. `page` alone does not opt in — it offsets the legacy 500-row pages exactly as before C1.
 */
export function isLegacyUnpagedRequest(dto: { limit?: unknown; cursor?: unknown; scope?: unknown }): boolean {
  return dto.limit === undefined && dto.cursor === undefined && dto.scope === undefined;
}
