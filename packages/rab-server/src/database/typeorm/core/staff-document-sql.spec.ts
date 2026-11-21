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
    expect(policies).toHaveLength(7);
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
    expect(sql).not.toMatch(
      /GRANT[^;]*DELETE[^;]*ON TABLE core\.staff_document TO/,
    );
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
    expect(insert).toContain("ARRAY['not_scanned'::text, 'clean'::text]");
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

  it('staffDocumentStateProblems accepts exactly the expected state and reports any drift', () => {
    const rows = Object.entries(EXPECTED_STAFF_DOCUMENT_STATE).map(
      ([tbl, s]) => ({ tbl, ...s }),
    );
    const fn = {
      owner: 'crewflow',
      definer: false,
      config: 'search_path=pg_catalog, pg_temp',
      app_execute: false,
      public_revoked: true,
    };
    expect(staffDocumentStateProblems(rows, fn)).toEqual([]);
    expect(
      staffDocumentStateProblems(
        rows.map((r) =>
          r.tbl === 'staff_document' ? { ...r, force: false } : r,
        ),
        fn,
      ),
    ).toEqual(['core.staff_document.force: expected true, found false']);
    expect(
      staffDocumentStateProblems(rows, { ...fn, definer: true }),
    ).toHaveLength(1);
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
