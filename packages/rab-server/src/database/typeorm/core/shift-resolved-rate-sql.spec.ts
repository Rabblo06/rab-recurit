import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  EXPECTED_SHIFT_RESOLVED_RATE_STATE,
  MARK_SHIFT_RATE_RESOLVED_FUNCTION_SQL,
  SHIFT_RESOLVED_RATE_OWNERSHIP_SQL,
  SHIFT_RESOLVED_RATE_PARITY_TRIGGERS,
  SHIFT_RESOLVED_RATE_SECURITY_SQL,
  SHIFT_RESOLVED_RATE_TABLE_SQL,
  shiftResolvedRateStateProblems,
} from './shift-resolved-rate-sql';

/** Static shape of ShiftResolvedRate1786722220000 (owner decisions 41 / 97; DRAFT, owner SQL review). DB behaviour: staff-role-rate.integration.spec.ts. */
const flat = (s: string) => s.replace(/\s+/g, ' ').trim();
const security = SHIFT_RESOLVED_RATE_SECURITY_SQL.map(flat);
const TENANT =
  '(organisation_id = core.current_org()) AND (workspace_id = core.current_workspace())';

describe('core.shift_resolved_rate SQL (decisions 41 / 97)', () => {
  it('a marker per shift: tenant columns, no amount, no foreign key into a workspace table', () => {
    const t = flat(SHIFT_RESOLVED_RATE_TABLE_SQL);
    expect(t).toContain(
      'CONSTRAINT shift_resolved_rate_pkey PRIMARY KEY (shift_id)',
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

  it('ENABLE + FORCE RLS, no PUBLIC; SELECT = tenant + a non-venue manager; INSERT = tenant + the caller as author; no UPDATE / DELETE policy', () => {
    expect(security).toEqual(
      expect.arrayContaining([
        'ALTER TABLE core.shift_resolved_rate ENABLE ROW LEVEL SECURITY',
        'ALTER TABLE core.shift_resolved_rate FORCE ROW LEVEL SECURITY',
        'REVOKE ALL ON TABLE core.shift_resolved_rate FROM PUBLIC',
      ]),
    );
    const policies = security.filter((s) => s.startsWith('CREATE POLICY'));
    expect(policies).toHaveLength(2);
    const select = policies.find((p) => p.includes('FOR SELECT'))!;
    expect(select).toContain(TENANT);
    expect(select).toContain(
      "(mp.type <> 'venue'::text) AND (mp.archived_at IS NULL)",
    );
    expect(policies.find((p) => p.includes('FOR INSERT'))).toContain(
      `WITH CHECK (${TENANT} AND (created_by = core.current_uid()))`,
    );
  });

  it('crewflow_app reads only; every write goes through the definer; the owner login is refused direct writes by the parity guard', () => {
    expect(security).toContain(
      'GRANT SELECT ON TABLE core.shift_resolved_rate TO crewflow_app',
    );
    expect(security.join('\n')).not.toMatch(
      /GRANT (INSERT|UPDATE|DELETE|ALL)[^\n]*shift_resolved_rate/,
    );
    const created = security
      .map((s) => /^CREATE TRIGGER (\S+) /.exec(s)?.[1])
      .filter(Boolean);
    expect([...created].sort()).toEqual(
      [...SHIFT_RESOLVED_RATE_PARITY_TRIGGERS].sort(),
    );
    expect(security).toContain(
      'REVOKE ALL ON FUNCTION core.mark_shift_rate_resolved(uuid) FROM PUBLIC',
    );
    expect(security).toContain(
      'GRANT EXECUTE ON FUNCTION core.mark_shift_rate_resolved(uuid) TO crewflow_app',
    );
    expect(SHIFT_RESOLVED_RATE_OWNERSHIP_SQL).toEqual([
      'ALTER TABLE core.shift_resolved_rate OWNER TO crewflow',
      'ALTER FUNCTION core.mark_shift_rate_resolved(uuid) OWNER TO crewflow',
    ]);
  });

  it('the definer: SECURITY DEFINER, pinned search_path, refuses without a tenant, and only marks a shift created by the caller in this transaction and workspace', () => {
    const fn = flat(MARK_SHIFT_RATE_RESOLVED_FUNCTION_SQL);
    expect(fn).toMatch(
      /SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS \$fn\$/,
    );
    expect(fn).toContain(
      'IF v_org IS NULL OR v_ws IS NULL OR v_uid IS NULL OR p_shift_id IS NULL THEN RAISE EXCEPTION',
    );
    // Both copies (workspace schema with HWS on, core with it off) are checked with the same predicate.
    expect(fn.match(/s\.created_by = \$4 AND s\.created_at = pg_catalog\.now\(\)/g)).toHaveLength(1);
    expect(fn).toContain("FOREACH v_schema IN ARRAY ARRAY['workspace_' || pg_catalog.replace(v_ws::text, '-', ''), 'core'] LOOP");
    expect(fn).toContain(
      "pg_catalog.format( 'SELECT EXISTS (SELECT 1 FROM %I.shift s WHERE s.id = $1",
    );
    expect(fn).toContain('USING p_shift_id, v_org, v_ws, v_uid');
    expect(fn).toContain("USING ERRCODE = '42501'");
  });

  it('the post-condition reports differences and nothing when as reviewed; the migration self-checks', () => {
    expect(
      shiftResolvedRateStateProblems({ ...EXPECTED_SHIFT_RESOLVED_RATE_STATE }),
    ).toEqual([]);
    expect(
      shiftResolvedRateStateProblems({
        ...EXPECTED_SHIFT_RESOLVED_RATE_STATE,
        fn: 'crewflow|definer=true||app=true|public=true',
      }),
    ).toHaveLength(1);
    const source = readFileSync(
      join(__dirname, 'migrations', '1786722220000-ShiftResolvedRate.ts'),
      'utf8',
    );
    expect(source).toContain('withCrewflowCoreCreate(queryRunner');
    expect(source).toContain('shiftResolvedRateStateProblems(state)');
    expect(source).toContain('secureOwnerInvariantViolations(');
  });
});
