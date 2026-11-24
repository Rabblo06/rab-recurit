import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  CORE_PAYROLL_MAKER_CHECKER_REVIEWED_DRIFT,
  CORE_PAYROLL_RUN_UPDATE_CHECK_AFTER_DEPARSED,
  CORE_PAYROLL_RUN_UPDATE_CHECK_BEFORE_DEPARSED,
  PAYROLL_MAKER_CHECKER_HASHES as H,
  PAYROLL_RECORD_GUARD_BODY_AFTER,
  PAYROLL_RECORD_GUARD_BLOCK,
  PAYROLL_RECORD_GUARD_BODY_BEFORE,
  PAYROLL_RECORD_GUARD_DECLARE_ADDED,
  payrollRecordGuardSql,
} from './payroll-maker-checker-sql';
import { SEMANTIC_GOLDEN_PG16 } from '../../posture-drift/semantic-golden.pg16';
import { SEMANTIC_GOLDEN_PG17 } from '../../posture-drift/semantic-golden.pg17';
import { SEMANTIC_GOLDEN_PG18 } from '../../posture-drift/semantic-golden.pg18';

const md5 = (s: string) => createHash('md5').update(s).digest('hex');

/** Static review of PayrollMakerCheckerBackstop1786723020000 (decision 5). Behaviour: payroll-maker-checker-rls.integration.spec.ts. */
describe('payroll maker-checker backstop SQL (decision 5)', () => {
  it('the BEFORE body is byte-for-byte the 1786719200000 body (its prosrc hash), and AFTER only adds the maker-checker block', () => {
    const original = readFileSync(join(__dirname, '..', 'core', 'migrations', '1786719200000-PayrollCalendarRunsPayslips.ts'), 'utf8').split('AS $fn$')[1]!.split('$fn$;')[0]!;
    expect(PAYROLL_RECORD_GUARD_BODY_BEFORE).toBe(original);
    expect(md5(`${PAYROLL_RECORD_GUARD_BODY_BEFORE}|`)).toBe(H.guardBodyBefore);
    expect(md5(`${PAYROLL_RECORD_GUARD_BODY_AFTER}|`)).toBe(H.guardBodyAfter);
    const removed = PAYROLL_RECORD_GUARD_BODY_AFTER.replace(PAYROLL_RECORD_GUARD_DECLARE_ADDED, '').replace(PAYROLL_RECORD_GUARD_BLOCK, '');
    expect(removed).toBe(PAYROLL_RECORD_GUARD_BODY_BEFORE);
    expect(PAYROLL_RECORD_GUARD_BLOCK).toContain('NEW.approved_by IS DISTINCT FROM core.current_uid()');
    expect(PAYROLL_RECORD_GUARD_BLOCK).toContain('OLD.approved_by IS NOT NULL');
    expect(PAYROLL_RECORD_GUARD_BLOCK).toContain('NOT coalesce(has_report, false) OR NOT coalesce(has_seat, false) OR finaliser IS NULL');
    expect(PAYROLL_RECORD_GUARD_BODY_AFTER).toContain("USING ERRCODE = '42501'");
    expect(payrollRecordGuardSql(PAYROLL_RECORD_GUARD_BODY_AFTER)).not.toMatch(/SECURITY DEFINER|OWNER TO|GRANT|REVOKE/);
  });

  it('the run policy narrows by one conjunct; hashes and goldens agree', () => {
    expect(CORE_PAYROLL_RUN_UPDATE_CHECK_AFTER_DEPARSED.startsWith(CORE_PAYROLL_RUN_UPDATE_CHECK_BEFORE_DEPARSED.slice(0, -1) + ' AND (')).toBe(true);
    expect(md5(CORE_PAYROLL_RUN_UPDATE_CHECK_BEFORE_DEPARSED)).toBe(H.runCheckBefore);
    expect(md5(CORE_PAYROLL_RUN_UPDATE_CHECK_AFTER_DEPARSED)).toBe(H.runCheckAfter);
    for (const golden of [SEMANTIC_GOLDEN_PG16, SEMANTIC_GOLDEN_PG17, SEMANTIC_GOLDEN_PG18]) {
      expect(golden).toContain(`policy|payroll_run|payroll_run_update|PERMISSIVE|public|w|using=${H.runUsing}|check=${H.runCheckAfter}`);
      expect(golden.some((l) => l.startsWith('function|payroll_record_guard()|owner=crewflow|definer=false|') && l.endsWith(`|body=${H.guardBodyAfter}`))).toBe(true);
    }
    expect(CORE_PAYROLL_MAKER_CHECKER_REVIEWED_DRIFT).toHaveLength(2);
  });
});
