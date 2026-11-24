import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  EXPECTED_SHIFT_EXPLICIT_RATE_STATE,
  SHIFT_EXPLICIT_RATE_OWNERSHIP_SQL,
  SHIFT_EXPLICIT_RATE_PARITY_TRIGGERS,
  SHIFT_EXPLICIT_RATE_SECURITY_SQL,
  SHIFT_EXPLICIT_RATE_TABLE_SQL,
  shiftExplicitRateStateProblems,
} from './shift-explicit-rate-sql';

/** Static shape of ShiftExplicitRate1786722220000 (owner decision 41; DRAFT, owner SQL review). DB behaviour: staff-role-rate.integration.spec.ts. */
const flat = (s: string) => s.replace(/\s+/g, ' ').trim();
const security = SHIFT_EXPLICIT_RATE_SECURITY_SQL.map(flat);
const TENANT =
  '(organisation_id = core.current_org()) AND (workspace_id = core.current_workspace())';
const MANAGER = "(mp.type <> 'venue'::text) AND (mp.archived_at IS NULL)";

describe('core.shift_explicit_rate SQL (decision 41)', () => {
  it('a marker per shift: tenant columns, no amount, no foreign key into a workspace table', () => {
    const t = flat(SHIFT_EXPLICIT_RATE_TABLE_SQL);
    expect(t).toContain(
      'CONSTRAINT shift_explicit_rate_pkey PRIMARY KEY (shift_id)',
    );
    for (const col of [
      'organisation_id uuid NOT NULL',
      'workspace_id uuid NOT NULL',
      'created_by uuid NOT NULL',
    ])
      expect(t).toContain(col);
    expect(t).not.toMatch(/pence/);
    expect(t).not.toMatch(/REFERENCES core\.shift\b/);
  });

  it('ENABLE + FORCE RLS, no PUBLIC; both policies bind tenant + a non-venue manager; INSERT names its author; no UPDATE / DELETE policy', () => {
    expect(security).toEqual(
      expect.arrayContaining([
        'ALTER TABLE core.shift_explicit_rate ENABLE ROW LEVEL SECURITY',
        'ALTER TABLE core.shift_explicit_rate FORCE ROW LEVEL SECURITY',
        'REVOKE ALL ON TABLE core.shift_explicit_rate FROM PUBLIC',
      ]),
    );
    const policies = security.filter((s) => s.startsWith('CREATE POLICY'));
    expect(policies).toHaveLength(2);
    for (const p of policies) {
      expect(p).toContain(TENANT);
      expect(p).toContain(MANAGER);
    }
    expect(policies.find((p) => p.includes('FOR INSERT'))).toContain(
      '(created_by = core.current_uid())',
    );
  });

  it('insert-only: crewflow_app SELECT + INSERT; the owner login refused UPDATE / DELETE / TRUNCATE by the reviewed parity guard', () => {
    expect(security).toContain(
      'GRANT SELECT, INSERT ON TABLE core.shift_explicit_rate TO crewflow_app',
    );
    const created = security
      .map((s) => /^CREATE TRIGGER (\S+) /.exec(s)?.[1])
      .filter(Boolean);
    expect([...created].sort()).toEqual(
      [...SHIFT_EXPLICIT_RATE_PARITY_TRIGGERS].sort(),
    );
    for (const s of security.filter((x) => x.startsWith('CREATE TRIGGER')))
      expect(s).toMatch(
        /FOR EACH STATEMENT EXECUTE FUNCTION core\.owner_login_grant_parity_guard\(\)$/,
      );
    expect(security.join('\n')).not.toMatch(/CREATE (OR REPLACE )?FUNCTION/);
    expect(SHIFT_EXPLICIT_RATE_OWNERSHIP_SQL).toEqual([
      'ALTER TABLE core.shift_explicit_rate OWNER TO crewflow',
    ]);
  });

  it('the post-condition reports differences and nothing when as reviewed; the migration self-checks', () => {
    expect(
      shiftExplicitRateStateProblems({ ...EXPECTED_SHIFT_EXPLICIT_RATE_STATE }),
    ).toEqual([]);
    expect(
      shiftExplicitRateStateProblems({
        ...EXPECTED_SHIFT_EXPLICIT_RATE_STATE,
        force: false,
      }),
    ).toHaveLength(1);
    const source = readFileSync(
      join(__dirname, 'migrations', '1786722220000-ShiftExplicitRate.ts'),
      'utf8',
    );
    expect(source).toContain('withCrewflowCoreCreate(queryRunner');
    expect(source).toContain('shiftExplicitRateStateProblems(state)');
    expect(source).toContain('secureOwnerInvariantViolations(');
  });
});
