import { BadRequestException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import {
  decodeKeysetCursor,
  decodeOptionalKeysetCursor,
  encodeKeysetCursor,
  KEYSET_CURSOR_MAX_LENGTH,
  keysetBeforeSql,
  keysetPage,
  keysetTimestampSql,
} from './keyset-cursor';
import {
  DEFAULT_PAGE_LIMIT,
  isLegacyUnpagedRequest,
  KeysetPaginationDto,
  keysetSkipTake,
  LEGACY_UNPAGED_LIMIT,
  MAX_PAGE_LIMIT,
  PaginationDto,
  paginationSkipTake,
} from './pagination.dto';

const ID = '0b7f4f0e-8d0a-4c55-9b7e-2f5c1e3d4a6b';
const T = '2026-10-30T12:34:56.123456Z';
const raw = (value: unknown) => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');

describe('keyset cursor (Phase C1, contract §3)', () => {
  it('round-trips a position exactly, microseconds included, and stays well under the length cap', () => {
    const cursor = encodeKeysetCursor({ t: T, i: ID });
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(cursor.length).toBeLessThan(KEYSET_CURSOR_MAX_LENGTH);
    expect(decodeKeysetCursor(cursor)).toEqual({ t: T, i: ID });
  });

  it('accepts an upper-case id and normalises it', () => {
    expect(decodeKeysetCursor(raw({ v: 1, t: T, i: ID.toUpperCase() }))).toEqual({ t: T, i: ID });
  });

  it.each([
    ['empty', ''],
    ['not base64url', 'a+b/c='],
    ['too long', 'A'.repeat(KEYSET_CURSOR_MAX_LENGTH + 1)],
    ['non-canonical base64url (trailing bits)', `${raw({ v: 1, t: T, i: ID })}A`],
    ['not JSON', Buffer.from('{nope').toString('base64url')],
    ['JSON null', raw(null)],
    ['JSON array', raw([T, ID])],
    ['JSON string', raw('x')],
    ['missing key', raw({ v: 1, t: T })],
    ['extra key (no smuggled scope)', raw({ v: 1, t: T, i: ID, organisationId: ID })],
    ['wrong version', raw({ v: 2, t: T, i: ID })],
    ['version as string', raw({ v: '1', t: T, i: ID })],
    ['numeric timestamp', raw({ v: 1, t: Date.parse(T), i: ID })],
    ['millisecond timestamp', raw({ v: 1, t: '2026-10-30T12:34:56.123Z', i: ID })],
    ['offset instead of Z', raw({ v: 1, t: '2026-10-30T12:34:56.123456+00:00', i: ID })],
    ['impossible date', raw({ v: 1, t: '2026-02-30T00:00:00.000000Z', i: ID })],
    ['hour 24', raw({ v: 1, t: '2026-10-30T24:00:00.000000Z', i: ID })],
    ['leap second', raw({ v: 1, t: '2026-12-31T23:59:60.000000Z', i: ID })],
    ['SQL in the timestamp', raw({ v: 1, t: "2026-10-30T12:34:56.123456Z'; DROP TABLE x; --", i: ID })],
    ['id not a uuid', raw({ v: 1, t: T, i: 'abc' })],
    ['id with SQL', raw({ v: 1, t: T, i: `${ID}' OR '1'='1` })],
  ])('rejects %s with 400 Invalid cursor', (_label, cursor) => {
    expect(() => decodeKeysetCursor(cursor as string)).toThrow(BadRequestException);
    expect(() => decodeKeysetCursor(cursor as string)).toThrow('Invalid cursor.');
  });

  it('treats an absent cursor as the first page', () => {
    expect(decodeOptionalKeysetCursor(undefined)).toBeNull();
    expect(decodeOptionalKeysetCursor('')).toBeNull();
  });

  it('refuses to encode a position it could not decode', () => {
    expect(() => encodeKeysetCursor({ t: '2026-10-30T12:34:56Z', i: ID })).toThrow();
    expect(() => encodeKeysetCursor({ t: T, i: 'x' })).toThrow();
  });

  it('builds the DESC/DESC row-comparison bound and the microsecond text form', () => {
    expect(keysetBeforeSql('o.sent_at', 'o.id', '$2', '$3')).toBe('(o.sent_at, o.id) < ($2::timestamptz, $3::uuid)');
    expect(keysetTimestampSql('o.sent_at')).toBe(`to_char(o.sent_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`);
  });

  it('keysetPage: take+1 rows -> a page of take and a cursor at its last row; take or fewer -> no cursor', () => {
    const rows = [1, 2, 3].map((n) => ({ ts: `2026-10-30T12:34:5${n}.000000Z`, id: ID.replace(/b$/, String(n)) }));
    const full = keysetPage(rows, 2, (r) => ({ t: r.ts, i: r.id }));
    expect(full.data).toEqual(rows.slice(0, 2));
    expect(decodeKeysetCursor(full.nextCursor!)).toEqual({ t: rows[1]!.ts, i: rows[1]!.id });
    expect(keysetPage(rows, 3, (r) => ({ t: r.ts, i: r.id }))).toEqual({ data: rows, nextCursor: null });
  });
});

describe('PaginationDto limits (Phase C1, contract §1-§2)', () => {
  const errorsFor = async (cls: typeof PaginationDto, query: Record<string, unknown>) =>
    (await validate(plainToInstance(cls, query), { whitelist: true, forbidNonWhitelisted: true })).map((e) => e.property);

  it('defaults to 50 rows and allows at most 200', async () => {
    expect(DEFAULT_PAGE_LIMIT).toBe(50);
    expect(MAX_PAGE_LIMIT).toBe(200);
    expect(paginationSkipTake({})).toEqual({ skip: 0, take: 50 });
    expect(paginationSkipTake({ page: 3, limit: 20 })).toEqual({ skip: 40, take: 20 });
    expect(await errorsFor(PaginationDto, { limit: '200' })).toEqual([]);
    expect(await errorsFor(PaginationDto, { limit: '201' })).toEqual(['limit']);
    expect(await errorsFor(PaginationDto, { limit: '1000' })).toEqual(['limit']);
  });

  it('a plain PaginationDto endpoint rejects `cursor` instead of silently ignoring it', async () => {
    expect(await errorsFor(PaginationDto, { cursor: 'AAAA' })).toEqual(['cursor']);
    expect(await errorsFor(KeysetPaginationDto, { cursor: 'AAAA' })).toEqual([]);
    expect(await errorsFor(KeysetPaginationDto, { cursor: 'not base64url!' })).toEqual(['cursor']);
    expect(await errorsFor(KeysetPaginationDto, { cursor: 'A'.repeat(KEYSET_CURSOR_MAX_LENGTH + 1) })).toEqual(['cursor']);
  });

  it('keysetSkipTake: a cursor starts at offset 0 and may not be combined with page > 1', () => {
    expect(keysetSkipTake({ cursor: 'AAAA', limit: 10 })).toEqual({ skip: 0, take: 10 });
    expect(keysetSkipTake({ cursor: 'AAAA', page: 1 })).toEqual({ skip: 0, take: 50 });
    expect(() => keysetSkipTake({ cursor: 'AAAA', page: 2 })).toThrow(BadRequestException);
    expect(keysetSkipTake({ page: 2, limit: 10 })).toEqual({ skip: 10, take: 10 });
  });

  it('LEGACY: only a request with none of limit/cursor/scope is the unpaged call, which keeps 500 rows', () => {
    expect(LEGACY_UNPAGED_LIMIT).toBe(500);
    expect(isLegacyUnpagedRequest({})).toBe(true);
    expect(isLegacyUnpagedRequest({ page: 2 } as never)).toBe(true);
    expect(isLegacyUnpagedRequest({ limit: 50 })).toBe(false);
    expect(isLegacyUnpagedRequest({ cursor: 'AAAA' })).toBe(false);
    expect(isLegacyUnpagedRequest({ scope: 'all' })).toBe(false);
  });
});
