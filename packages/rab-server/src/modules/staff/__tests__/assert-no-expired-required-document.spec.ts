import { ConflictException } from '@nestjs/common';

import { assertNoExpiredRequiredDocument } from '../services/assert-no-expired-required-document';
import {
  daysBetween,
  isCalendarDate,
  isExpiredOn,
  londonDate,
} from '../services/staff-document-rules';

/** A fake EntityManager answering the requirement overrides and the offer-block definer. */
function fakeManager(
  overrides: Array<{ document_type: string; required: boolean }>,
  blocked: Array<{ document_type: string; expired_on: string }>,
) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  return {
    calls,
    query: async (sql: string, params: unknown[]) => {
      calls.push({ sql, params });
      return sql.includes('staff_document_requirement') ? overrides : blocked;
    },
  };
}

const staff = { userId: 'u1', organisationId: 'o1', workspaceId: 'w1' };
const inTwoDays = new Date(Date.now() + 48 * 3600 * 1000);

describe('assertNoExpiredRequiredDocument', () => {
  it('reads through the tenant-pinned definer (review H1), never the caller-RLS table directly', async () => {
    const m = fakeManager([], []);
    await assertNoExpiredRequiredDocument(m as never, staff, inTwoDays);
    expect(m.calls[1]!.sql).toContain(
      'core.staff_document_offer_block($1, $2::text[], $3::date)',
    );
    expect(m.calls[1]!.sql).not.toMatch(
      /FROM core\.staff_document\b(?!_offer_block)/,
    );
    expect(m.calls[1]!.params).toEqual([
      'u1',
      ['right_to_work'],
      londonDate(inTwoDays),
    ]);
  });

  it('a blocked type is a 409 with the reason code and the expiry date', async () => {
    const m = fakeManager(
      [],
      [{ document_type: 'right_to_work', expired_on: '2020-01-31' }],
    );
    const err = await assertNoExpiredRequiredDocument(
      m as never,
      staff,
      inTwoDays,
    ).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).getResponse()).toMatchObject({
      code: 'STAFF_REQUIRED_DOCUMENT_EXPIRED',
      documentTypes: ['right_to_work'],
    });
    expect(
      ((err as ConflictException).getResponse() as { message: string }).message,
    ).toContain('Right to work (expired 2020-01-31)');
  });

  it('an organisation that requires nothing never asks the definer', async () => {
    const m = fakeManager(
      [{ document_type: 'right_to_work', required: false }],
      [{ document_type: 'right_to_work', expired_on: '2020-01-01' }],
    );
    await expect(
      assertNoExpiredRequiredDocument(m as never, staff, inTwoDays),
    ).resolves.toBeUndefined();
    expect(m.calls).toHaveLength(1);
  });

  it('a shift in the past is checked against today, never an earlier date', async () => {
    const m = fakeManager([], []);
    await assertNoExpiredRequiredDocument(
      m as never,
      staff,
      new Date('2020-01-01T10:00:00Z'),
    );
    expect(m.calls[1]!.params[2]).toBe(londonDate(new Date()));
  });
});

describe('staff document date rules', () => {
  it('valid up to and including the expiry date', () => {
    expect(isExpiredOn('2026-11-21', '2026-11-21')).toBe(false);
    expect(isExpiredOn('2026-11-20', '2026-11-21')).toBe(true);
    expect(isExpiredOn(null, '2026-11-21')).toBe(false);
  });

  it('calendar dates and day counts', () => {
    expect(isCalendarDate('2026-02-28')).toBe(true);
    expect(isCalendarDate('2026-02-30')).toBe(false);
    expect(isCalendarDate('26-02-01')).toBe(false);
    expect(daysBetween('2026-03-28', '2026-03-30')).toBe(2);
    expect(daysBetween('2026-11-21', '2026-11-21')).toBe(0);
    expect(londonDate(new Date('2026-06-30T23:30:00Z'))).toBe('2026-07-01');
  });
});
