import { rolledUpHolidayPayPence } from '@rab/shared';

import {
  EXPECTED_HOLIDAY_PAY_STATE,
  HOLIDAY_PAY_INSERT_GUARD_FUNCTION_SQL,
  HOLIDAY_PAY_OWNERSHIP_SQL,
  HOLIDAY_PAY_PARITY_TRIGGERS,
  HOLIDAY_PAY_SECURITY_SQL,
  HOLIDAY_PAY_TABLES_SQL,
  HOLIDAY_SETTING_UPDATABLE_COLUMNS,
  holidayPayStateProblems,
} from './payroll-holiday-pay-sql';

/** Static shape of PayrollHolidayPay1786723110000 (DRAFT, owner SQL review). Behaviour: payroll-holiday-pay.integration.spec.ts. */
const flat = (s: string) => s.replace(/\s+/g, ' ').trim();
const tables = flat(HOLIDAY_PAY_TABLES_SQL);
const security = HOLIDAY_PAY_SECURITY_SQL.map(flat);
const policy = (name: string) => security.find((s) => s.startsWith(`CREATE POLICY ${name} `))!;

describe('holiday pay SQL (owner decision 4)', () => {
  it('setting: one row per organisation, two modes, a rate only for rolled-up, 1..10000 basis points', () => {
    expect(tables).toContain('CONSTRAINT organisation_payroll_setting_pkey PRIMARY KEY (organisation_id)');
    expect(tables).toContain("CHECK (holiday_pay_mode IN ('rolled_up', 'provider'))");
    expect(tables).toContain("CHECK (((holiday_pay_mode = 'rolled_up') = (holiday_pay_rate_bps IS NOT NULL)) AND (holiday_pay_rate_bps IS NULL OR holiday_pay_rate_bps BETWEEN 1 AND 10000))");
  });

  it('snapshot: one per payroll record, money bigint pence, and a CHECK that re-derives the rounding (half up)', () => {
    expect(tables).toContain('CONSTRAINT payroll_record_holiday_pay_record_key UNIQUE (organisation_id, workspace_id, payroll_record_id)');
    for (const col of ['base_pence bigint NOT NULL', 'holiday_pay_pence bigint NOT NULL', 'organisation_id uuid NOT NULL', 'workspace_id uuid NOT NULL', 'staff_user_id uuid NOT NULL']) expect(tables).toContain(col);
    expect(tables).toContain("CHECK ( (mode = 'provider' AND holiday_pay_pence = 0) OR (mode = 'rolled_up' AND holiday_pay_pence = (base_pence * rate_bps + 5000) / 10000))");
    expect(tables).toContain('CHECK (base_pence >= 0 AND base_pence <= 100000000000 AND holiday_pay_pence >= 0)');
    expect(tables).not.toMatch(/REFERENCES core\.(payroll_record|staff_profile)\b/);
  });

  it('the database rounding formula equals @rab/shared rolledUpHolidayPayPence on every edge (integer division of non-negatives = floor)', () => {
    const sqlRule = (base: number, bps: number) => Number((BigInt(base) * BigInt(bps) + 5000n) / 10000n);
    for (const [base, bps] of [[0, 1207], [1, 5000], [3, 5000], [4, 1207], [5, 1207], [4142, 1207], [6000, 1207], [9479, 1207], [100_000_000_000, 10000], [123_456_789, 1]]) {
      expect(rolledUpHolidayPayPence(base!, bps!)).toBe(sqlRule(base!, bps!));
    }
    // The base ceiling keeps base * rate inside bigint (1e11 * 1e4 = 1e15).
    expect(100_000_000_000 * 10_000).toBeLessThan(Number.MAX_SAFE_INTEGER);
  });

  it('ENABLE + FORCE RLS and no PUBLIC access on both tables, in the same migration', () => {
    for (const t of ['organisation_payroll_setting', 'payroll_record_holiday_pay']) {
      expect(security).toContain(`ALTER TABLE core.${t} ENABLE ROW LEVEL SECURITY`);
      expect(security).toContain(`ALTER TABLE core.${t} FORCE ROW LEVEL SECURITY`);
      expect(security).toContain(`REVOKE ALL ON TABLE core.${t} FROM PUBLIC`);
    }
  });

  it('setting: read by non-venue managers of the organisation; written only by the CURRENT Initial Manager naming themselves', () => {
    expect(policy('organisation_payroll_setting_select')).toContain("(organisation_id = core.current_org()) AND (EXISTS (SELECT 1 FROM core.manager_profile mp WHERE (mp.user_id = core.current_uid()) AND (mp.organisation_id = core.current_org()) AND (mp.type <> 'venue'::text) AND (mp.archived_at IS NULL)))");
    for (const p of ['organisation_payroll_setting_insert', 'organisation_payroll_setting_update']) {
      expect(policy(p)).toContain("(mp.type = 'internal'::text) AND mp.is_initial_manager AND (mp.superseded_at IS NULL)");
      expect(policy(p)).toContain('(updated_by = core.current_uid())');
    }
    expect(security.some((s) => /organisation_payroll_setting AS PERMISSIVE FOR DELETE/.test(s))).toBe(false);
  });

  it('snapshot: managers, the staff member it pays and the Worker read; only a workspace manager inserts; never updated or deleted', () => {
    const select = policy('payroll_record_holiday_pay_select');
    expect(select).toContain('(organisation_id = core.current_org()) AND (workspace_id = core.current_workspace())');
    expect(select).toContain('(staff_user_id = core.current_uid())');
    expect(select).toContain("(current_setting('rab.actor_type'::text, true) = 'worker'::text)");
    expect(policy('payroll_record_holiday_pay_insert')).toContain('(created_by = core.current_uid())');
    expect(security.some((s) => /payroll_record_holiday_pay AS PERMISSIVE FOR (UPDATE|DELETE)/.test(s))).toBe(false);
    expect(security).toContain('GRANT SELECT, INSERT ON TABLE core.payroll_record_holiday_pay TO crewflow_app');
    expect(security.some((s) => /GRANT UPDATE .* ON TABLE core\.payroll_record_holiday_pay/.test(s))).toBe(false);
  });

  it('grants and parity: setting UPDATE allow-list, snapshot UPDATE refused per statement, DELETE / TRUNCATE refused on both', () => {
    expect(security).toContain(`GRANT UPDATE (${HOLIDAY_SETTING_UPDATABLE_COLUMNS.join(', ')}) ON TABLE core.organisation_payroll_setting TO crewflow_app`);
    const triggers = security.filter((s) => /^CREATE TRIGGER _.*_grant_parity_/.test(s)).map((s) => /CREATE TRIGGER (\S+)/.exec(s)![1]).sort();
    expect(triggers).toEqual([...HOLIDAY_PAY_PARITY_TRIGGERS].sort());
    expect(security.find((s) => s.startsWith('CREATE TRIGGER _payroll_record_holiday_pay_grant_parity_update'))).toContain('FOR EACH STATEMENT');
  });

  it('review fix 2: a BEFORE INSERT guard refuses a line for a record a FINALISED run holds (same organisation and workspace) and sets the clock', () => {
    const g = flat(HOLIDAY_PAY_INSERT_GUARD_FUNCTION_SQL);
    expect(g).toContain('SET search_path = pg_catalog, core');
    expect(g).not.toMatch(/SECURITY DEFINER/);
    expect(g).toContain('NEW.created_at := pg_catalog.now();');
    expect(g).toContain("IF EXISTS (SELECT 1 FROM core.payroll_run_event e WHERE e.organisation_id = NEW.organisation_id AND e.workspace_id = NEW.workspace_id AND e.event = 'finalised' AND NEW.payroll_record_id = ANY (e.payroll_record_ids)) THEN");
    expect(g).toContain("USING ERRCODE = '42501'");
    expect(security).toContain('CREATE TRIGGER payroll_record_holiday_pay_insert_guard BEFORE INSERT ON core.payroll_record_holiday_pay FOR EACH ROW EXECUTE FUNCTION core.payroll_record_holiday_pay_insert_guard()');
  });

  it('ownership to crewflow; the post-condition accepts the reviewed state and reports differences', () => {
    expect(HOLIDAY_PAY_OWNERSHIP_SQL).toEqual([
      'ALTER TABLE core.organisation_payroll_setting OWNER TO crewflow',
      'ALTER TABLE core.payroll_record_holiday_pay OWNER TO crewflow',
      'ALTER FUNCTION core.payroll_record_holiday_pay_insert_guard() OWNER TO crewflow',
    ]);
    const ok = Object.entries(EXPECTED_HOLIDAY_PAY_STATE).map(([table_name, s]) => ({ table_name, ...s }));
    expect(holidayPayStateProblems(ok)).toEqual([]);
    expect(holidayPayStateProblems(ok.slice(1))).toEqual(['core.organisation_payroll_setting: missing']);
    expect(holidayPayStateProblems(ok.map((r) => ({ ...r, force: false })))).toHaveLength(2);
  });
});
