import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { migrationSourceViolations } from './migration-source-rules';
import { STAFF_DOCUMENT_GUARD_FUNCTION_SQL } from './staff-document-sql';
import {
  STAFF_DOCUMENT_GUARD_V1_RESTORE_SQL,
  STAFF_DOCUMENT_GUARD_V2_SQL,
} from './staff-document-guard-scan-binding-sql';

/** StaffDocumentGuardScanBinding1786722320000 (v2 re-review Low): SQL shape, without a database. */
describe('staff document guard scan binding (StaffDocumentGuardScanBinding1786722320000)', () => {
  it('replaces only the crewflow scan branch, binding it like core.staff_document_record_scan()', () => {
    for (const fragment of [
      "OR NEW.scan_status IS DISTINCT FROM 'clean'",
      'OR OLD.uploaded_by IS DISTINCT FROM v_uid OR OLD.created_at IS DISTINCT FROM pg_catalog.now()',
      'OR OLD.organisation_id IS DISTINCT FROM core.current_org() OR OLD.workspace_id IS DISTINCT FROM core.current_workspace() THEN',
    ]) {
      expect(STAFF_DOCUMENT_GUARD_V2_SQL).toContain(fragment);
    }
    expect(
      STAFF_DOCUMENT_GUARD_V2_SQL.startsWith(
        'CREATE OR REPLACE FUNCTION core.staff_document_guard()',
      ),
    ).toBe(true);
    // Everything else is the approved v1 body.
    const strip = (s: string) =>
      s
        .replace('CREATE OR REPLACE FUNCTION', 'CREATE FUNCTION')
        .split('\n')
        .filter(
          (l) =>
            !/^\s+OR (NEW\.scan_status|OLD\.uploaded_by|OLD\.organisation_id)/.test(
              l,
            ),
        );
    const v1 = STAFF_DOCUMENT_GUARD_FUNCTION_SQL.split('\n');
    const v2 = strip(STAFF_DOCUMENT_GUARD_V2_SQL);
    expect(v2.filter((l) => !v1.includes(l))).toEqual([
      "    IF current_user IS DISTINCT FROM 'crewflow'::name OR OLD.scan_status <> 'not_scanned' OR NEW.status IS DISTINCT FROM OLD.status",
    ]);
    expect(v2.length).toBe(v1.length);
  });

  it('down() restores the approved v1 body byte for byte', () => {
    expect(
      STAFF_DOCUMENT_GUARD_V1_RESTORE_SQL.replace(
        'CREATE OR REPLACE FUNCTION',
        'CREATE FUNCTION',
      ),
    ).toBe(STAFF_DOCUMENT_GUARD_FUNCTION_SQL);
  });

  it('is a new migration that follows the post-Phase-0b source rules', () => {
    const source = readFileSync(
      join(
        __dirname,
        'migrations',
        '1786722320000-StaffDocumentGuardScanBinding.ts',
      ),
      'utf8',
    );
    expect(migrationSourceViolations(source)).toEqual([]);
  });
});
