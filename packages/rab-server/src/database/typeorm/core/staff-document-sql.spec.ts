import {
  NotificationType,
  REQUIRABLE_STAFF_DOCUMENT_TYPES,
  STAFF_DOCUMENT_TYPES,
} from '@rab/shared';

import { migrationSourceViolations } from './migration-source-rules';
import {
  EXPECTED_STAFF_DOCUMENT_STATE,
  NOTIFICATION_TYPES_AFTER_1786722300000,
  REQUIRABLE_STAFF_DOCUMENT_TYPES_1786722300000,
  STAFF_DOCUMENT_GUARD_FUNCTION_SQL,
  STAFF_DOCUMENT_SECURITY_SQL,
  STAFF_DOCUMENT_TABLES_SQL,
  STAFF_DOCUMENT_TYPES_1786722300000,
  STAFF_DOCUMENT_UPDATABLE_COLUMNS,
  staffDocumentStateProblems,
  EXPECTED_STAFF_DOCUMENT_FUNCTIONS,
  STAFF_DOCUMENT_OFFER_BLOCK_FUNCTION_SQL,
  STAFF_DOCUMENT_RECORD_SCAN_FUNCTION_SQL,
} from './staff-document-sql';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** StaffDocumentSchema1786722300000: SQL shape, without a database (the integration suite proves behaviour). */
describe('staff document SQL (StaffDocumentSchema1786722300000)', () => {
  it('the frozen type lists equal @rab/shared (a new type needs a new migration)', () => {
    expect([...STAFF_DOCUMENT_TYPES_1786722300000]).toEqual([
      ...STAFF_DOCUMENT_TYPES,
    ]);
    expect([...REQUIRABLE_STAFF_DOCUMENT_TYPES_1786722300000]).toEqual([
      ...REQUIRABLE_STAFF_DOCUMENT_TYPES,
    ]);
    expect(REQUIRABLE_STAFF_DOCUMENT_TYPES_1786722300000).not.toContain(
      'other',
    );
  });

  it('the widened notification CHECK holds every NotificationType', () => {
    expect([...NOTIFICATION_TYPES_AFTER_1786722300000].sort()).toEqual(
      Object.values(NotificationType).sort(),
    );
  });

  it('both tables get ENABLE + FORCE RLS and no PUBLIC access; every policy is tenant-bound', () => {
    for (const t of ['staff_document', 'staff_document_requirement']) {
      expect(STAFF_DOCUMENT_SECURITY_SQL).toContain(
        `ALTER TABLE core.${t} ENABLE ROW LEVEL SECURITY`,
      );
      expect(STAFF_DOCUMENT_SECURITY_SQL).toContain(
        `ALTER TABLE core.${t} FORCE ROW LEVEL SECURITY`,
      );
      expect(STAFF_DOCUMENT_SECURITY_SQL).toContain(
        `REVOKE ALL ON TABLE core.${t} FROM PUBLIC`,
      );
    }
    const policies = STAFF_DOCUMENT_SECURITY_SQL.filter((s) =>
      s.startsWith('CREATE POLICY'),
    );
    expect(policies).toHaveLength(9);
    for (const p of policies)
      expect(p).toContain('organisation_id = core.current_org()');
    for (const p of policies.filter((x) =>
      x.includes('ON core.staff_document AS'),
    ))
      expect(p).toContain('workspace_id = core.current_workspace()');
  });

  it('no DELETE on documents: neither a policy nor a grant (history is retained)', () => {
    const sql = STAFF_DOCUMENT_SECURITY_SQL.join('\n');
    expect(sql).not.toMatch(/staff_document_delete/);
    for (const g of STAFF_DOCUMENT_SECURITY_SQL.filter((x) => x.startsWith('GRANT') && x.includes('ON TABLE core.staff_document TO'))) {
      expect(g).not.toContain('DELETE');
    }
    expect(EXPECTED_STAFF_DOCUMENT_STATE.staff_document.acl).not.toContain(
      'DELETE',
    );
  });

  it('a manager can never decide their own document; inserts start pending and never infected', () => {
    const update = STAFF_DOCUMENT_SECURITY_SQL.find((s) =>
      s.startsWith('CREATE POLICY staff_document_update'),
    )!;
    expect(update).toContain('staff_user_id <> core.current_uid()');
    expect(update).toContain("mp.type <> 'venue'::text");
    const insert = STAFF_DOCUMENT_SECURITY_SQL.find((s) =>
      s.startsWith('CREATE POLICY staff_document_insert'),
    )!;
    expect(insert).toContain("status = 'pending'::text");
    expect(insert).toContain("(scan_status = 'not_scanned'::text)");
    expect(insert).not.toContain("'clean'");
    expect(insert).toContain('uploaded_by = core.current_uid()');
  });

  it('the updatable columns never include identity, file or dates', () => {
    for (const c of [
      'organisation_id',
      'workspace_id',
      'staff_user_id',
      'document_type',
      'file_id',
      'issued_on',
      'expires_on',
      'uploaded_by',
    ]) {
      expect(STAFF_DOCUMENT_UPDATABLE_COLUMNS).not.toContain(c);
    }
  });

  it('the guard is SECURITY INVOKER with a pinned search_path, and mirrors the transition table', () => {
    expect(STAFF_DOCUMENT_GUARD_FUNCTION_SQL).not.toMatch(/SECURITY DEFINER/);
    expect(STAFF_DOCUMENT_GUARD_FUNCTION_SQL).toContain(
      'SET search_path = pg_catalog, pg_temp',
    );
    expect(STAFF_DOCUMENT_GUARD_FUNCTION_SQL).toContain(
      "(OLD.status = 'pending' AND NEW.status IN ('verified', 'rejected', 'revoked'))",
    );
    expect(STAFF_DOCUMENT_GUARD_FUNCTION_SQL).toContain(
      "(OLD.status = 'verified' AND NEW.status = 'revoked')",
    );
  });

  it('a clean scan verdict needs recorded scanner evidence (DB CHECK)', () => {
    expect(STAFF_DOCUMENT_TABLES_SQL).toContain(
      "(scan_status = 'not_scanned' AND scan_engine IS NULL AND scanned_at IS NULL)",
    );
  });

  it('review M1 / M3: the guard enforces clean-before-verify, decider = current user, maker-checker, and the scanner-only path', () => {
    for (const fragment of [
      "IF NEW.scan_status IS DISTINCT FROM 'clean' THEN",
      'IF NEW.verified_by IS DISTINCT FROM v_uid THEN',
      'IF NEW.verified_by = NEW.uploaded_by THEN',
      "ELSIF NEW.status = 'rejected' AND NEW.rejected_by IS DISTINCT FROM v_uid THEN",
      "ELSIF NEW.status = 'revoked' AND NEW.revoked_by IS DISTINCT FROM v_uid THEN",
      "IF current_user IS DISTINCT FROM 'crewflow'::name OR OLD.scan_status <> 'not_scanned'",
      'NEW.created_at := pg_catalog.now();',
    ]) {
      expect(STAFF_DOCUMENT_GUARD_FUNCTION_SQL).toContain(fragment);
    }
    expect(STAFF_DOCUMENT_SECURITY_SQL).toContain(
      'CREATE TRIGGER staff_document_guard BEFORE INSERT OR UPDATE ON core.staff_document FOR EACH ROW EXECUTE FUNCTION core.staff_document_guard()',
    );
    expect(STAFF_DOCUMENT_UPDATABLE_COLUMNS).not.toContain('scan_status');
    expect(STAFF_DOCUMENT_RECORD_SCAN_FUNCTION_SQL).toContain('AND uploaded_by = core.current_uid() AND status = \'pending\' AND scan_status = \'not_scanned\' AND created_at = pg_catalog.now()');
  });

  it('review H1 / H2: the offer-block definer is tenant-pinned, fails closed without a tenant, and only a VERIFIED replacement lifts a block', () => {
    expect(STAFF_DOCUMENT_OFFER_BLOCK_FUNCTION_SQL).toContain('SECURITY DEFINER');
    expect(STAFF_DOCUMENT_OFFER_BLOCK_FUNCTION_SQL).toContain('SET search_path = pg_catalog, pg_temp');
    expect(STAFF_DOCUMENT_OFFER_BLOCK_FUNCTION_SQL).toContain('IF v_org IS NULL OR v_ws IS NULL');
    expect(STAFF_DOCUMENT_OFFER_BLOCK_FUNCTION_SQL).toContain("v.status = 'verified' AND (v.expires_on IS NULL OR v.expires_on >= p_on_date)");
    expect(STAFF_DOCUMENT_OFFER_BLOCK_FUNCTION_SQL).toContain('RETURNS TABLE (document_type text, expired_on date)');
  });

  it('review M2: only the CEO or the current Initial Manager writes requirements', () => {
    for (const p of STAFF_DOCUMENT_SECURITY_SQL.filter((x) => /POLICY staff_document_requirement_(insert|update|delete)/.test(x))) {
      expect(p).toContain("(mp.type = 'ceo'::text) OR ((mp.type = 'internal'::text) AND mp.is_initial_manager AND (mp.superseded_at IS NULL))");
    }
  });

  it('staffDocumentStateProblems accepts exactly the expected state and reports any drift', () => {
    const rows = Object.entries(EXPECTED_STAFF_DOCUMENT_STATE).map(
      ([tbl, s]) => ({ tbl, ...s }),
    );
    const fns = Object.entries(EXPECTED_STAFF_DOCUMENT_FUNCTIONS).map(([fn, f]) => ({ fn, ...f }));
    expect(staffDocumentStateProblems(rows, fns)).toEqual([]);
    expect(staffDocumentStateProblems(rows.map((r) => (r.tbl === 'staff_document' ? { ...r, force: false } : r)), fns)).toEqual([
      'core.staff_document.force: expected true, found false',
    ]);
    expect(staffDocumentStateProblems(rows, fns.map((f) => (f.fn === 'core.staff_document_guard()' ? { ...f, definer: true } : f)))).toHaveLength(1);
    expect(staffDocumentStateProblems(rows, fns.slice(1))).toEqual(['core.staff_document_guard(): missing']);
  });

  it('the migration follows the post-Phase-0b source rules (ownership handed over inside withCrewflowCoreCreate)', () => {
    const source = readFileSync(
      join(__dirname, 'migrations', '1786722300000-StaffDocumentSchema.ts'),
      'utf8',
    );
    expect(migrationSourceViolations(source)).toEqual([]);
    expect(source).toContain('withCrewflowCoreCreate(');
  });
});
