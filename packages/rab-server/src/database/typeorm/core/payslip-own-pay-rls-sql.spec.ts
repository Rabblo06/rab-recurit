import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  CORE_PAYSLIP_DOCUMENT_INSERT_CHECK_AFTER_DEPARSED,
  CORE_PAYSLIP_DOCUMENT_INSERT_CHECK_BEFORE_DEPARSED,
  CORE_PAYSLIP_OWN_PAY_REVIEWED_DRIFT,
  CORE_PAYSLIP_UPDATE_CHECK_AFTER_DEPARSED,
  CORE_PAYSLIP_UPDATE_CHECK_BEFORE_DEPARSED,
  CORE_PAYSLIP_UPDATE_USING_DEPARSED,
  PAYSLIP_OWN_PAY_HASHES,
  payslipDocumentInsertCheckSql,
  payslipOwnPayAlterSql,
  payslipUpdateCheckSql,
} from './payslip-own-pay-rls-sql';
import { SEMANTIC_GOLDEN_PG16 } from '../../posture-drift/semantic-golden.pg16';
import { SEMANTIC_GOLDEN_PG17 } from '../../posture-drift/semantic-golden.pg17';
import { SEMANTIC_GOLDEN_PG18 } from '../../posture-drift/semantic-golden.pg18';

const collapse = (s: string) => s.replace(/\s+/g, ' ').trim();
const md5 = (s: string) => createHash('md5').update(collapse(s)).digest('hex');

/**
 * Static review of PayslipOwnPayRls1786723000000 (decision 51). The database behaviour (own payslip refused for the runtime
 * login, others allowed) is proven by payslip-own-pay-rls.integration.spec.ts.
 */
describe('payslip own-pay RLS SQL (decision 51)', () => {
  it('the builders produce exactly the deparsed expressions the hashes pin (before and after)', () => {
    expect(collapse(payslipUpdateCheckSql('core', false))).toBe(CORE_PAYSLIP_UPDATE_CHECK_BEFORE_DEPARSED);
    expect(collapse(payslipUpdateCheckSql('core', true))).toBe(CORE_PAYSLIP_UPDATE_CHECK_AFTER_DEPARSED);
    expect(collapse(payslipDocumentInsertCheckSql('core', false))).toBe(CORE_PAYSLIP_DOCUMENT_INSERT_CHECK_BEFORE_DEPARSED);
    expect(collapse(payslipDocumentInsertCheckSql('core', true))).toBe(CORE_PAYSLIP_DOCUMENT_INSERT_CHECK_AFTER_DEPARSED);
    expect(md5(CORE_PAYSLIP_UPDATE_USING_DEPARSED)).toBe(PAYSLIP_OWN_PAY_HASHES.updateUsing);
    expect(md5(CORE_PAYSLIP_UPDATE_CHECK_BEFORE_DEPARSED)).toBe(PAYSLIP_OWN_PAY_HASHES.updateCheckBefore);
    expect(md5(CORE_PAYSLIP_UPDATE_CHECK_AFTER_DEPARSED)).toBe(PAYSLIP_OWN_PAY_HASHES.updateCheckAfter);
    expect(md5(CORE_PAYSLIP_DOCUMENT_INSERT_CHECK_BEFORE_DEPARSED)).toBe(PAYSLIP_OWN_PAY_HASHES.documentInsertCheckBefore);
    expect(md5(CORE_PAYSLIP_DOCUMENT_INSERT_CHECK_AFTER_DEPARSED)).toBe(PAYSLIP_OWN_PAY_HASHES.documentInsertCheckAfter);
  });

  it('each new expression is the old one plus exactly one appended conjunct (it can only narrow)', () => {
    const strip = (s: string) => s.slice(0, -1);
    expect(CORE_PAYSLIP_UPDATE_CHECK_AFTER_DEPARSED.startsWith(strip(CORE_PAYSLIP_UPDATE_CHECK_BEFORE_DEPARSED) + ' AND (NOT (EXISTS (')).toBe(true);
    expect(CORE_PAYSLIP_DOCUMENT_INSERT_CHECK_AFTER_DEPARSED.startsWith(strip(CORE_PAYSLIP_DOCUMENT_INSERT_CHECK_BEFORE_DEPARSED) + ' AND (NOT (EXISTS (')).toBe(true);
    expect(CORE_PAYSLIP_UPDATE_CHECK_AFTER_DEPARSED).toContain('(sp.id = payslip.staff_profile_id) AND (sp.user_id = core.current_uid())');
    expect(CORE_PAYSLIP_DOCUMENT_INSERT_CHECK_AFTER_DEPARSED).toContain('(ps.id = payslip_document.payslip_id) AND (sp.user_id = core.current_uid())');
  });

  it('the semantic goldens (PG 16 / 17 / 18) pin the new WITH CHECK hashes and the unchanged USING', () => {
    for (const golden of [SEMANTIC_GOLDEN_PG16, SEMANTIC_GOLDEN_PG17, SEMANTIC_GOLDEN_PG18]) {
      expect(golden).toContain(`policy|payslip|payslip_update|PERMISSIVE|public|w|using=${PAYSLIP_OWN_PAY_HASHES.updateUsing}|check=${PAYSLIP_OWN_PAY_HASHES.updateCheckAfter}`);
      expect(golden).toContain(`policy|payslip_document|payslip_document_insert|PERMISSIVE|public|a|using=-|check=${PAYSLIP_OWN_PAY_HASHES.documentInsertCheckAfter}`);
    }
  });

  it('only WITH CHECK is altered, never USING; no grant, role, table or function statement', () => {
    const sql = payslipOwnPayAlterSql('core', true);
    expect(sql.match(/ALTER POLICY/g)).toHaveLength(2);
    expect(sql).not.toMatch(/\bUSING\s*\(/);
    expect(sql).not.toMatch(/\b(GRANT|REVOKE|CREATE|DROP|OWNER|ROLE|FUNCTION|TRIGGER)\b/i);
    const migration = readFileSync(join(__dirname, 'migrations', '1786723000000-PayslipOwnPayRls.ts'), 'utf8');
    expect(migration).not.toMatch(/\b(GRANT|REVOKE|CREATE POLICY|DROP POLICY|OWNER TO)\b/);
  });

  it('the reviewed privilege drift lists both policies before and after, and nothing else', () => {
    expect(CORE_PAYSLIP_OWN_PAY_REVIEWED_DRIFT).toHaveLength(4);
    expect(CORE_PAYSLIP_OWN_PAY_REVIEWED_DRIFT.filter((l) => l.startsWith('- '))).toHaveLength(2);
    expect(CORE_PAYSLIP_OWN_PAY_REVIEWED_DRIFT.every((l) => / policy\|payslip(_document)?\|payslip_(update|document_insert)\|[wa]\|permissive=true\|roles=public\|/.test(l))).toBe(true);
  });

  it('refuses any schema other than core or a canonical workspace schema', () => {
    expect(() => payslipUpdateCheckSql('public', true)).toThrow(/invalid schema/);
    expect(() => payslipDocumentInsertCheckSql('workspace_x; DROP', true)).toThrow(/invalid schema/);
    expect(payslipUpdateCheckSql(`workspace_${'a'.repeat(32)}`, true)).toContain(`"workspace_${'a'.repeat(32)}".staff_profile sp`);
  });
});
