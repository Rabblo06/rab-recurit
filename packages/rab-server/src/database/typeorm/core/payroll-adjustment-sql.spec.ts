import {
  EXPECTED_PAYROLL_ADJUSTMENT_STATE,
  PAYROLL_ADJUSTMENT_GUARD_FUNCTION_SQL,
  PAYROLL_ADJUSTMENT_MAX_PENCE,
  PAYROLL_ADJUSTMENT_OWNERSHIP_SQL,
  PAYROLL_ADJUSTMENT_PARITY_TRIGGERS,
  PAYROLL_ADJUSTMENT_SECURITY_SQL,
  PAYROLL_ADJUSTMENT_TABLE_SQL,
  PAYROLL_ADJUSTMENT_UPDATABLE_COLUMNS,
  payrollAdjustmentStateProblems,
} from './payroll-adjustment-sql';

/**
 * Static shape of PayrollAdjustmentSchema1786723100000 (DRAFT, owner SQL review). The database behaviour (RLS, grants,
 * CHECKs, the guard trigger, the parity guard) is proven in payroll-adjustments.integration.spec.ts; this pins the text.
 */
const flat = (s: string) => s.replace(/\s+/g, ' ').trim();
const table = flat(PAYROLL_ADJUSTMENT_TABLE_SQL);
const security = PAYROLL_ADJUSTMENT_SECURITY_SQL.map(flat);
const policy = (name: string) => security.find((s) => s.startsWith(`CREATE POLICY ${name} `))!;
const TENANT = '(organisation_id = core.current_org()) AND (workspace_id = core.current_workspace())';
const MANAGER = "(mp.type <> 'venue'::text) AND (mp.archived_at IS NULL)";

describe('core.payroll_adjustment SQL (owner decision 3)', () => {
  it('tenant columns NOT NULL, money bigint pence, exactly three kinds and three statuses', () => {
    for (const col of [
      'organisation_id uuid NOT NULL',
      'workspace_id uuid NOT NULL',
      'staff_profile_id uuid NOT NULL',
      'staff_user_id uuid NOT NULL',
      'kind text NOT NULL',
      'amount_pence bigint NOT NULL',
      'reason text NOT NULL',
      'created_by uuid NOT NULL',
    ]) {
      expect(table).toContain(col);
    }
    expect(table).toContain("CHECK (kind IN ('correction', 'bonus', 'expense'))");
    expect(table).toContain("CHECK (status IN ('pending_approval', 'approved', 'rejected'))");
    // No deduction kind exists at all (Employment Rights Act 1996 s.13).
    expect(table).not.toMatch(/deduction/);
  });

  it('only a correction may be negative, nothing is zero, and a correction always names its original record', () => {
    expect(table).toContain(
      `CHECK (amount_pence <> 0 AND amount_pence >= -${PAYROLL_ADJUSTMENT_MAX_PENCE} AND amount_pence <= ${PAYROLL_ADJUSTMENT_MAX_PENCE} AND (kind = 'correction' OR amount_pence > 0))`,
    );
    expect(table).toContain("CHECK ((kind = 'correction') = (corrects_payroll_record_id IS NOT NULL))");
  });

  it('segregation of duties is a database CHECK: creator != paid person; decider != creator and != paid person', () => {
    expect(table).toContain(
      'CHECK ((created_by <> staff_user_id) AND (decided_by IS NULL OR (decided_by <> created_by AND decided_by <> staff_user_id)))',
    );
  });

  it('decision and run columns are consistent; only an approved line joins a run; a lock needs a run', () => {
    expect(table).toContain("CHECK (((status = 'pending_approval') = (decided_by IS NULL)) AND ((decided_by IS NULL) = (decided_at IS NULL)))");
    expect(table).toContain("CHECK (((run_id IS NULL) = (included_at IS NULL)) AND (run_id IS NULL OR status = 'approved') AND (locked_at IS NULL OR run_id IS NOT NULL))");
  });

  it('core shape: no foreign key into a workspace table; organisation, workspace and user keys only', () => {
    expect(table).not.toMatch(/REFERENCES core\.(staff_profile|payroll_record|payroll_run)\b/);
    expect(table).toContain('FOREIGN KEY (workspace_id, organisation_id) REFERENCES core.manager_workspace(id, organisation_id)');
    expect(table).toContain('FOREIGN KEY (organisation_id) REFERENCES core.organisation(id) ON DELETE CASCADE');
    for (const c of ['staff_user_id', 'created_by', 'decided_by']) expect(table).toContain(`FOREIGN KEY (${c}) REFERENCES core."user"(id)`);
  });

  it('ENABLE + FORCE RLS and no PUBLIC access, in the same migration', () => {
    expect(security.slice(0, 3)).toEqual([
      'ALTER TABLE core.payroll_adjustment ENABLE ROW LEVEL SECURITY',
      'ALTER TABLE core.payroll_adjustment FORCE ROW LEVEL SECURITY',
      'REVOKE ALL ON TABLE core.payroll_adjustment FROM PUBLIC',
    ]);
  });

  it('every policy binds the tenant AND a non-venue, non-archived workspace manager; staff read only their own APPROVED lines', () => {
    for (const [name, cmd] of [
      ['payroll_adjustment_select', 'SELECT'],
      ['payroll_adjustment_insert', 'INSERT'],
      ['payroll_adjustment_update', 'UPDATE'],
    ] as const) {
      const p = policy(name);
      expect(p).toContain(`AS PERMISSIVE FOR ${cmd} TO PUBLIC`);
      expect(p).toContain(TENANT);
      expect(p).toContain(MANAGER);
    }
    expect(policy('payroll_adjustment_select')).toContain("((staff_user_id = core.current_uid()) AND (status = 'approved'::text))");
    expect(policy('payroll_adjustment_insert')).toContain('(created_by = core.current_uid())');
    expect(policy('payroll_adjustment_insert')).toContain("(status = 'pending_approval'::text) AND (decided_by IS NULL)");
    expect(policy('payroll_adjustment_insert')).toContain('(run_id IS NULL) AND (included_at IS NULL) AND (locked_at IS NULL)');
    expect(security.some((s) => /FOR DELETE/.test(s))).toBe(false);
  });

  it('grants: SELECT + INSERT, UPDATE on the decision and run columns only, never DELETE', () => {
    expect(security).toContain('GRANT SELECT, INSERT ON TABLE core.payroll_adjustment TO crewflow_app');
    expect(security).toContain(`GRANT UPDATE (${PAYROLL_ADJUSTMENT_UPDATABLE_COLUMNS.join(', ')}) ON TABLE core.payroll_adjustment TO crewflow_app`);
    for (const frozen of ['amount_pence', 'kind', 'reason', 'staff_user_id', 'staff_profile_id', 'created_by', 'corrects_payroll_record_id', 'organisation_id', 'workspace_id']) {
      expect(PAYROLL_ADJUSTMENT_UPDATABLE_COLUMNS).not.toContain(frozen);
    }
    expect(security.some((s) => /GRANT .*DELETE/.test(s))).toBe(false);
  });

  it('the guard: lock first, immutable figures, pending -> approved | rejected only, the decision names the session, run stays', () => {
    const g = flat(PAYROLL_ADJUSTMENT_GUARD_FUNCTION_SQL);
    expect(g).toContain('SET search_path = pg_catalog, core');
    expect(g).not.toMatch(/SECURITY DEFINER/);
    expect(g.indexOf('OLD.locked_at IS NOT NULL')).toBeLessThan(g.indexOf('NEW.status IS DISTINCT FROM OLD.status'));
    for (const c of ['amount_pence', 'kind', 'reason', 'staff_user_id', 'created_by', 'corrects_payroll_record_id']) {
      expect(g).toContain(`NEW.${c} IS DISTINCT FROM OLD.${c}`);
    }
    expect(g).toContain("IF NOT (OLD.status = 'pending_approval' AND NEW.status IN ('approved', 'rejected')) THEN");
    expect(g).toContain('IF NEW.decided_by IS DISTINCT FROM core.current_uid() THEN');
    expect(g).toContain('IF OLD.run_id IS NOT NULL AND (NEW.run_id IS DISTINCT FROM OLD.run_id');
    expect(security).toContain('CREATE TRIGGER payroll_adjustment_guard BEFORE UPDATE ON core.payroll_adjustment FOR EACH ROW EXECUTE FUNCTION core.payroll_adjustment_guard()');
  });

  it('grant parity with the reviewed function: UPDATE allow-list = the runtime columns, DELETE and TRUNCATE refused', () => {
    const triggers = security.filter((s) => s.startsWith('CREATE TRIGGER _payroll_adjustment_grant_parity_'));
    expect(triggers.map((s) => /CREATE TRIGGER (\S+)/.exec(s)![1]).sort()).toEqual([...PAYROLL_ADJUSTMENT_PARITY_TRIGGERS].sort());
    expect(triggers.find((s) => s.includes('_update'))).toContain(
      `core.owner_login_grant_parity_guard(${PAYROLL_ADJUSTMENT_UPDATABLE_COLUMNS.map((c) => `'${c}'`).join(', ')})`,
    );
    // The parity UPDATE guard sorts before the state guard (PostgreSQL fires same-kind triggers in name order).
    expect('_payroll_adjustment_grant_parity_update' < 'payroll_adjustment_guard').toBe(true);
  });

  it('ownership goes to crewflow (table and guard function)', () => {
    expect(PAYROLL_ADJUSTMENT_OWNERSHIP_SQL).toEqual([
      'ALTER TABLE core.payroll_adjustment OWNER TO crewflow',
      'ALTER FUNCTION core.payroll_adjustment_guard() OWNER TO crewflow',
    ]);
  });

  it('the post-condition reports every difference and accepts the reviewed state', () => {
    expect(payrollAdjustmentStateProblems({ ...EXPECTED_PAYROLL_ADJUSTMENT_STATE })).toEqual([]);
    expect(payrollAdjustmentStateProblems(undefined)).toEqual(['core.payroll_adjustment: missing']);
    expect(payrollAdjustmentStateProblems({ ...EXPECTED_PAYROLL_ADJUSTMENT_STATE, force: false })).toEqual([
      'core.payroll_adjustment.force: expected true, found false',
    ]);
    expect(payrollAdjustmentStateProblems({ ...EXPECTED_PAYROLL_ADJUSTMENT_STATE, acl: 'crewflow_app:DELETE,crewflow_app:INSERT,crewflow_app:SELECT' })).toHaveLength(1);
  });
});
