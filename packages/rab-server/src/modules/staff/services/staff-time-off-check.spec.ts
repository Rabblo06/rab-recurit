import { ConflictException } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import {
  assertNoApprovedTimeOff,
  organisationToday,
  STAFF_TIME_OFF_BLOCK_SQL,
  StaffTimeOffBlockRow,
  StaffTimeOffConflictException,
} from './staff-time-off-check';

/**
 * Owner decision 42 (hard block), without a database: the contract of the one statement (organisation time zone, the
 * end-minus-1µs last day, both ids, approved only) and every fail-closed path. The day arithmetic itself runs on
 * PostgreSQL's time-zone data and is proven against real PostgreSQL in staff-time-off.integration.spec.ts (overnight, a
 * daylight-saving change, an organisation zone ahead of UTC).
 */
const flat = STAFF_TIME_OFF_BLOCK_SQL.replace(/\s+/g, ' ');
const staff = { staffProfileId: 'profile-1', staffUserId: 'user-1' };
const window = {
  startsAt: new Date('2026-12-01T22:00:00.000Z'),
  endsAt: new Date('2026-12-02T04:00:00.000Z'),
};

function fake(rows: StaffTimeOffBlockRow[] | Array<Record<string, unknown>>) {
  const query = jest.fn(async () => rows);
  return { manager: { query } as unknown as EntityManager, query };
}

const ok: StaffTimeOffBlockRow = {
  first_day: '2026-12-01',
  last_day: '2026-12-02',
  reader: true,
  blocked_on: null,
};

describe('assertNoApprovedTimeOff (decision 42)', () => {
  it('the statement judges days in the organisation time zone, the last day at end - 1 microsecond, approved rows only, both ids', () => {
    expect(flat).toContain(
      '($1::timestamptz AT TIME ZONE o.timezone)::date AS first_day',
    );
    expect(flat).toContain(
      "(($2::timestamptz - interval '1 microsecond') AT TIME ZONE o.timezone)::date AS last_day",
    );
    expect(flat).toContain(
      'FROM core.organisation o WHERE o.id = core.current_org()',
    );
    expect(flat).toContain(
      "WHERE t.staff_profile_id = $3::uuid AND t.staff_user_id = $4::uuid AND t.status = 'approved'",
    );
    expect(flat).toContain(
      'AND t.starts_on <= w.last_day AND t.ends_on >= w.first_day',
    );
    // The reader probe mirrors the two SELECT policies of core.staff_time_off.
    expect(flat).toContain("mp.type <> 'venue' AND mp.archived_at IS NULL");
    expect(flat).toContain('OR core.current_uid() = $4::uuid');
  });

  it('passes the window as ISO instants and the two ids as bound parameters', async () => {
    const { manager, query } = fake([ok]);
    await assertNoApprovedTimeOff(manager, staff, window);
    expect(query).toHaveBeenCalledWith(STAFF_TIME_OFF_BLOCK_SQL, [
      '2026-12-01T22:00:00.000Z',
      '2026-12-02T04:00:00.000Z',
      'profile-1',
      'user-1',
    ]);
  });

  it('approved time off on a touched day → 409 STAFF_TIME_OFF naming that day', async () => {
    const { manager } = fake([{ ...ok, blocked_on: '2026-12-02' }]);
    const error = await assertNoApprovedTimeOff(manager, staff, window).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(StaffTimeOffConflictException);
    expect((error as ConflictException).getStatus()).toBe(409);
    expect((error as ConflictException).getResponse()).toEqual({
      statusCode: 409,
      code: 'STAFF_TIME_OFF',
      message: 'This staff member has approved time off on 2026-12-02.',
    });
  });

  it.each([
    ['no organisation row visible (no tenant context)', []],
    ['more than one row', [ok, ok]],
    [
      "the session could not see this staff member's time off through RLS",
      [{ ...ok, reader: false }],
    ],
    ['the reader probe was NULL', [{ ...ok, reader: null }]],
    ['no first day', [{ ...ok, first_day: null }]],
  ])(
    'fails closed (409 STAFF_TIME_OFF_UNVERIFIABLE, never a pass) when %s',
    async (_why, rows) => {
      const { manager } = fake(rows as StaffTimeOffBlockRow[]);
      await expect(
        assertNoApprovedTimeOff(manager, staff, window),
      ).rejects.toMatchObject({
        response: { code: 'STAFF_TIME_OFF_UNVERIFIABLE' },
      });
    },
  );

  it('an empty, inverted or invalid window fails closed without querying', async () => {
    for (const w of [
      { startsAt: window.startsAt, endsAt: window.startsAt },
      { startsAt: window.endsAt, endsAt: window.startsAt },
      { startsAt: new Date('nope'), endsAt: window.endsAt },
    ]) {
      const { manager, query } = fake([ok]);
      await expect(
        assertNoApprovedTimeOff(manager, staff, w),
      ).rejects.toMatchObject({
        response: { code: 'STAFF_TIME_OFF_UNVERIFIABLE' },
      });
      expect(query).not.toHaveBeenCalled();
    }
  });

  it('a requested (unapproved) range is not a block: only approved rows are ever matched', () => {
    expect(flat).not.toMatch(/status IN|'requested'/);
  });
});

describe('organisationToday', () => {
  it("is today in the organisation's zone and throws (never guesses) when no organisation is visible", async () => {
    const seen = fake([{ day: '2026-11-25' }]);
    await expect(organisationToday(seen.manager)).resolves.toBe('2026-11-25');
    expect((seen.query.mock.calls[0] as unknown as [string])[0]).toContain(
      "to_char(now() AT TIME ZONE o.timezone, 'YYYY-MM-DD')",
    );
    await expect(organisationToday(fake([]).manager)).rejects.toThrow(
      /refusing to guess/,
    );
  });
});
