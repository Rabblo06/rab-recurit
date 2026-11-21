import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EntityManager } from 'typeorm';

import { resolveSeatPayRate } from './staff-role-rate-resolution';

/**
 * `resolveSeatPayRate`: the staff-aware seat rate (architecture §1 A6), used at confirmation (authoritative snapshot) and at
 * send (estimate). PostgreSQL does the date filtering, so this spec pins the query (workspace binding, the venue-rate date
 * comparison, latest effective_from first) and what is done with the row PostgreSQL returns. The real-database behaviour —
 * staff rate wins over venue / default, falls back when none is in force, future and ended rates ignored, latest wins,
 * a confirmed snapshot never changes — is in staff-role-rate.integration.spec.ts.
 */
function fakeManager(rows: Array<{ pay_rate_pence: string | number }>) {
  const query = jest.fn(async (_sql: string, _params: unknown[]) => rows);
  return { manager: { query } as unknown as EntityManager, query };
}

const params = {
  staffProfileId: 'staff-1',
  jobRoleId: 'role-1',
  startsAt: new Date('2026-12-05T18:00:00.000Z'),
  fallbackPence: 1400,
};

describe('resolveSeatPayRate', () => {
  it('a staff role rate in force wins over the shift rate (venue rate / job role default / explicit)', async () => {
    const fake = fakeManager([{ pay_rate_pence: '2350' }]);
    await expect(resolveSeatPayRate(fake.manager, params)).resolves.toEqual({
      payRatePence: 2350,
      source: 'staff_role_rate',
    });
  });

  it('no staff role rate in force → the shift rate, exactly as before (including the £0 fallback the shift may carry)', async () => {
    await expect(
      resolveSeatPayRate(fakeManager([]).manager, params),
    ).resolves.toEqual({ payRatePence: 1400, source: 'shift' });
    await expect(
      resolveSeatPayRate(fakeManager([]).manager, {
        ...params,
        fallbackPence: 0,
      }),
    ).resolves.toEqual({ payRatePence: 0, source: 'shift' });
  });

  it('the query: session workspace + organisation, this staff member and job role, in force on the start, latest effective_from first', async () => {
    const fake = fakeManager([]);
    await resolveSeatPayRate(fake.manager, params);
    const [sql, bound] = fake.query.mock.calls[0]!;
    const flat = sql.replace(/\s+/g, ' ');
    expect(flat).toContain('FROM core.staff_role_rate r');
    expect(flat).toContain(
      'r.workspace_id = core.current_workspace() AND r.organisation_id = core.current_org()',
    );
    expect(flat).toContain('r.staff_profile_id = $1 AND r.job_role_id = $2');
    // The venue role rate's own comparison (SchedulingService.resolvePayRate): both ends inclusive, an open end never ends.
    expect(flat).toContain(
      'r.effective_from <= $3 AND (r.effective_to IS NULL OR r.effective_to >= $3)',
    );
    expect(flat).toContain('ORDER BY r.effective_from DESC LIMIT 1');
    // The start is bound as its UTC ISO string (PostgreSQL reads it as a date), never interpolated.
    expect(bound).toEqual(['staff-1', 'role-1', '2026-12-05T18:00:00.000Z']);
  });

  it('a string start is normalised to the same UTC ISO form; an invalid start refuses (fail closed)', async () => {
    const fake = fakeManager([]);
    await resolveSeatPayRate(fake.manager, {
      ...params,
      startsAt: '2026-12-05T19:00:00+01:00',
    });
    expect(fake.query.mock.calls[0]![1]![2]).toBe('2026-12-05T18:00:00.000Z');
    await expect(
      resolveSeatPayRate(fake.manager, { ...params, startsAt: 'not a date' }),
    ).rejects.toThrow('invalid start');
  });

  it('an unsafe stored amount is refused, never rounded into a plausible number', async () => {
    await expect(
      resolveSeatPayRate(
        fakeManager([{ pay_rate_pence: '9007199254740993' }]).manager,
        params,
      ),
    ).rejects.toThrow();
  });

  it('is the single lookup: confirmation and send both call it, and nothing else reads core.staff_role_rate for pay', () => {
    const offerDir = join(__dirname, '..', '..', 'offer', 'services');
    for (const file of ['apply-offer-confirmation.ts', 'offer.service.ts']) {
      expect(readFileSync(join(offerDir, file), 'utf8')).toMatch(
        /resolveSeatPayRate\(manager, \{/,
      );
    }
    const confirmation = readFileSync(
      join(offerDir, 'apply-offer-confirmation.ts'),
      'utf8',
    );
    expect(confirmation).toMatch(
      /payRateSnapshotPence: seatRate\.payRatePence/,
    );
    const send = readFileSync(join(offerDir, 'offer.service.ts'), 'utf8');
    expect(send).toMatch(/payRateSnapshotPence: seatRate\.payRatePence/);
    expect(send).toMatch(
      /payForMinutes\(seatRate\.payRatePence, workedMinutes\)/,
    );
  });
});
