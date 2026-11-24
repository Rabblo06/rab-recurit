import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EntityManager } from 'typeorm';

import {
  recordExplicitShiftRate,
  resolveSeatPayRate,
} from './staff-role-rate-resolution';

/**
 * `resolveSeatPayRate`: the seat rate (architecture §1 A6) under owner decisions 40 and 41, used at confirmation
 * (authoritative snapshot) and at send (estimate). PostgreSQL does the date filtering, so this spec pins the queries
 * (explicit marker first, workspace binding, the organisation-local date, latest effective_from first) and what is done
 * with the rows PostgreSQL returns. The real-database behaviour — explicit beats staff rate, staff rate beats venue /
 * default, falls back when none is in force, organisation time zone, a confirmed snapshot never changes — is in
 * staff-role-rate.integration.spec.ts.
 */
function fakeManager(opts: {
  explicit?: boolean;
  day?: string;
  rows?: Array<{ pay_rate_pence: string | number }>;
}) {
  const query = jest.fn(async (sql: string, _params: unknown[]) => {
    if (sql.includes('core.shift_explicit_rate'))
      return [{ explicit: opts.explicit ?? false }];
    if (sql.includes('AT TIME ZONE'))
      return [{ day: opts.day ?? '2026-12-05' }];
    return opts.rows ?? [];
  });
  return { manager: { query } as unknown as EntityManager, query };
}

const params = {
  shiftId: 'shift-1',
  staffProfileId: 'staff-1',
  jobRoleId: 'role-1',
  startsAt: new Date('2026-12-05T18:00:00.000Z'),
  fallbackPence: 1400,
};

describe('resolveSeatPayRate', () => {
  it('decision 41: a rate typed on the shift wins over a staff role rate, and no staff rate is read', async () => {
    const fake = fakeManager({
      explicit: true,
      rows: [{ pay_rate_pence: '2350' }],
    });
    await expect(resolveSeatPayRate(fake.manager, params)).resolves.toEqual({
      payRatePence: 1400,
      source: 'explicit_shift_rate',
    });
    expect(fake.query).toHaveBeenCalledTimes(1);
    const [sql, bound] = fake.query.mock.calls[0]!;
    expect(sql.replace(/\s+/g, ' ')).toContain(
      'e.shift_id = $1 AND e.workspace_id = core.current_workspace() AND e.organisation_id = core.current_org()',
    );
    expect(bound).toEqual(['shift-1']);
  });

  it('no explicit rate: a staff role rate in force wins over the shift rate (venue rate / job role default)', async () => {
    await expect(
      resolveSeatPayRate(
        fakeManager({ rows: [{ pay_rate_pence: '2350' }] }).manager,
        params,
      ),
    ).resolves.toEqual({ payRatePence: 2350, source: 'staff_role_rate' });
  });

  it('no explicit rate and no staff role rate in force → the shift rate, exactly as before', async () => {
    await expect(
      resolveSeatPayRate(fakeManager({}).manager, params),
    ).resolves.toEqual({ payRatePence: 1400, source: 'shift' });
  });

  it('decision 40: the staff rate query compares the organisation-local date, both ends inclusive, latest effective_from first', async () => {
    const fake = fakeManager({ day: '2026-12-06' });
    await resolveSeatPayRate(fake.manager, {
      ...params,
      startsAt: new Date('2026-12-05T23:30:00.000Z'),
    });
    const [dateSql, dateBound] = fake.query.mock.calls[1]!;
    expect(dateSql).toContain(
      'AT TIME ZONE coalesce((SELECT o.timezone FROM core.organisation o WHERE o.id = core.current_org())',
    );
    expect(dateBound).toEqual(['2026-12-05T23:30:00.000Z']);
    const [sql, bound] = fake.query.mock.calls[2]!;
    const flat = sql.replace(/\s+/g, ' ');
    expect(flat).toContain('FROM core.staff_role_rate r');
    expect(flat).toContain(
      'r.workspace_id = core.current_workspace() AND r.organisation_id = core.current_org()',
    );
    expect(flat).toContain('r.staff_profile_id = $1 AND r.job_role_id = $2');
    expect(flat).toContain(
      'r.effective_from <= $3::date AND (r.effective_to IS NULL OR r.effective_to >= $3::date)',
    );
    expect(flat).toContain('ORDER BY r.effective_from DESC LIMIT 1');
    expect(bound).toEqual(['staff-1', 'role-1', '2026-12-06']);
  });

  it('an invalid start refuses (fail closed); an unsafe stored amount is refused, never rounded', async () => {
    await expect(
      resolveSeatPayRate(fakeManager({}).manager, {
        ...params,
        startsAt: 'not a date',
      }),
    ).rejects.toThrow('invalid instant');
    await expect(
      resolveSeatPayRate(
        fakeManager({ rows: [{ pay_rate_pence: '9007199254740993' }] }).manager,
        params,
      ),
    ).rejects.toThrow();
  });

  it('recordExplicitShiftRate writes the marker with the session organisation and author (never client values)', async () => {
    const query = jest.fn(async (..._args: unknown[]) => []);
    await recordExplicitShiftRate({ query } as unknown as EntityManager, {
      id: 'shift-9',
      workspaceId: 'ws-1',
    });
    const [sql, bound] = query.mock.calls[0]! as [string, unknown[]];
    expect(sql).toBe(
      'INSERT INTO core.shift_explicit_rate (shift_id, organisation_id, workspace_id, created_by) VALUES ($1, core.current_org(), $2, core.current_uid())',
    );
    expect(bound).toEqual(['shift-9', 'ws-1']);
  });

  it('is the single lookup: confirmation and send both call it; the marker is written only by insertNewShiftTx for an explicit rate', () => {
    const offerDir = join(__dirname, '..', '..', 'offer', 'services');
    for (const file of ['apply-offer-confirmation.ts', 'offer.service.ts']) {
      expect(readFileSync(join(offerDir, file), 'utf8')).toMatch(
        /resolveSeatPayRate\(manager, \{\s+shiftId: shift\.id,/,
      );
    }
    expect(
      readFileSync(join(offerDir, 'apply-offer-confirmation.ts'), 'utf8'),
    ).toMatch(/payRateSnapshotPence: seatRate\.payRatePence/);
    const send = readFileSync(join(offerDir, 'offer.service.ts'), 'utf8');
    expect(send).toMatch(/payRateSnapshotPence: seatRate\.payRatePence/);
    expect(send).toMatch(
      /payForMinutes\(seatRate\.payRatePence, workedMinutes\)/,
    );
    const scheduling = readFileSync(
      join(
        __dirname,
        '..',
        '..',
        'scheduling',
        'services',
        'scheduling.service.ts',
      ),
      'utf8',
    );
    expect(scheduling).toMatch(
      /if \(input\.payRatePence !== undefined\) await recordExplicitShiftRate\(manager, saved\);/,
    );
  });
});
