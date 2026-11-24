import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  PAYROLL_MAKER_CHECKER_HASHES as H,
  PAYROLL_RECORD_GUARD_BLOCK,
  PAYROLL_RECORD_GUARD_BODY_AFTER,
  PAYROLL_RECORD_GUARD_BODY_BEFORE,
  PAYROLL_RECORD_GUARD_DECLARE_ADDED,
  payrollRecordGuardSql,
} from './payroll-maker-checker-sql';
import { SEMANTIC_GOLDEN_PG16 } from '../../posture-drift/semantic-golden.pg16';
import { SEMANTIC_GOLDEN_PG17 } from '../../posture-drift/semantic-golden.pg17';
import { SEMANTIC_GOLDEN_PG18 } from '../../posture-drift/semantic-golden.pg18';

const md5 = (s: string) => createHash('md5').update(s).digest('hex');

/** Static review of PayrollMakerCheckerBackstop1786723020000 (decision 5). Behaviour: payroll-maker-checker-rls / payroll-approval integration specs. */
describe('payroll maker-checker backstop SQL (decision 5)', () => {
  it('the BEFORE body is byte-for-byte the 1786719200000 body; AFTER only adds the DECLARE lines and the block', () => {
    const original = readFileSync(join(__dirname, '..', 'core', 'migrations', '1786719200000-PayrollCalendarRunsPayslips.ts'), 'utf8').split('AS $fn$')[1]!.split('$fn$;')[0]!;
    expect(PAYROLL_RECORD_GUARD_BODY_BEFORE).toBe(original);
    expect(md5(`${PAYROLL_RECORD_GUARD_BODY_BEFORE}|`)).toBe(H.guardBodyBefore);
    expect(md5(`${PAYROLL_RECORD_GUARD_BODY_AFTER}|`)).toBe(H.guardBodyAfter);
    expect(PAYROLL_RECORD_GUARD_BODY_AFTER.replace(PAYROLL_RECORD_GUARD_DECLARE_ADDED, '').replace(PAYROLL_RECORD_GUARD_BLOCK, '')).toBe(PAYROLL_RECORD_GUARD_BODY_BEFORE);
  });

  it('the block: checked on the move to approved, caller-bound, no worker exemption, fail closed, insert-only history; approved_by frozen otherwise', () => {
    expect(PAYROLL_RECORD_GUARD_BLOCK).toContain("IF NEW.status = 'approved' AND OLD.status IS DISTINCT FROM 'approved' THEN");
    expect(PAYROLL_RECORD_GUARD_BLOCK).toContain('NEW.approved_by IS DISTINCT FROM core.current_uid()');
    expect(PAYROLL_RECORD_GUARD_BLOCK).not.toContain('is_worker');
    expect(PAYROLL_RECORD_GUARD_BLOCK).toContain('report_id IS NULL OR seat_id IS NULL OR finaliser IS NULL OR reviewer IS NULL');
    expect(PAYROLL_RECORD_GUARD_BLOCK).toContain("al.action = 'attendance.report_finalised'");
    expect(PAYROLL_RECORD_GUARD_BLOCK).toContain("al.action = 'attendance.reviewed'");
    expect(PAYROLL_RECORD_GUARD_BLOCK).toContain('ELSIF NEW.approved_by IS DISTINCT FROM OLD.approved_by THEN');
    expect(payrollRecordGuardSql(PAYROLL_RECORD_GUARD_BODY_AFTER)).not.toMatch(/SECURITY DEFINER|OWNER TO|GRANT|REVOKE/);
  });

  it('the semantic goldens (PG 16 / 17 / 18) pin the new body; the run policy is unchanged in this PR', () => {
    for (const golden of [SEMANTIC_GOLDEN_PG16, SEMANTIC_GOLDEN_PG17, SEMANTIC_GOLDEN_PG18]) {
      expect(golden.some((l) => l.startsWith('function|payroll_record_guard()|owner=crewflow|definer=false|') && l.endsWith(`|body=${H.guardBodyAfter}`))).toBe(true);
      expect(golden).toContain('policy|payroll_run|payroll_run_update|PERMISSIVE|public|w|using=de27c66e727763f94d047d16e9656077|check=de27c66e727763f94d047d16e9656077');
    }
  });
});
