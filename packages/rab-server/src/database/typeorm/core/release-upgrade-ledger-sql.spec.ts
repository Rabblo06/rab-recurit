/**
 * Phase X U-2 (DRAFT): the release-upgrade ledger SQL, database-free. The live behaviour (insert-only, deny, definer,
 * attempt numbers, redaction) is release-upgrade-ledger.integration.spec.ts.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  RECORD_FUNCTION_SIGNATURE,
  RELEASE_UPGRADE_LEDGER_DOWN_SQL,
  RELEASE_UPGRADE_LEDGER_EXPECTED_STATE,
  RELEASE_UPGRADE_LEDGER_UP_SQL,
} from './release-upgrade-ledger-sql';

const UP = RELEASE_UPGRADE_LEDGER_UP_SQL.join(';\n');
const DEFINER = RELEASE_UPGRADE_LEDGER_UP_SQL.find((s) => s.startsWith('CREATE FUNCTION core.release_upgrade_record('))!;

describe('release-upgrade ledger SQL (Phase X U-2, draft)', () => {
  it('no organisation_id: not tenant data; ENABLE + FORCE in the same migration; owner rab_secure_owner', () => {
    expect(UP).not.toMatch(/organisation_id/);
    expect(UP).toContain('ALTER TABLE core.release_upgrade_event ENABLE ROW LEVEL SECURITY');
    expect(UP).toContain('ALTER TABLE core.release_upgrade_event FORCE ROW LEVEL SECURITY');
    expect(UP).toContain('ALTER TABLE core.release_upgrade_event OWNER TO rab_secure_owner');
    expect(RELEASE_UPGRADE_LEDGER_EXPECTED_STATE.tables).toBe('release_upgrade_event:rab_secure_owner:r:true:true');
  });

  it('insert-only: the owner keeps SELECT + INSERT, nobody else holds anything, no UPDATE / DELETE policy exists', () => {
    expect(UP).toContain('REVOKE ALL ON TABLE core.release_upgrade_event FROM PUBLIC, crewflow, crewflow_app');
    expect(UP).toContain('GRANT SELECT, INSERT ON TABLE core.release_upgrade_event TO rab_secure_owner');
    expect(UP).not.toMatch(/GRANT[^;]*(UPDATE|DELETE|TRUNCATE)[^;]*release_upgrade_event/);
    expect(UP).not.toMatch(/FOR (UPDATE|DELETE)/);
    expect(RELEASE_UPGRADE_LEDGER_EXPECTED_STATE.table_acl).toBe('release_upgrade_event:rab_secure_owner:INSERT:false,release_upgrade_event:rab_secure_owner:SELECT:false');
    expect(RELEASE_UPGRADE_LEDGER_EXPECTED_STATE.policies).toContain('release_upgrade_event_runtime_deny:*:false:crewflow+crewflow_app');
  });

  it('the one writer: SECURITY DEFINER, pinned search_path, no PUBLIC / runtime EXECUTE, owner rab_secure_owner', () => {
    expect(DEFINER).toMatch(/LANGUAGE plpgsql VOLATILE SECURITY DEFINER\nSET search_path = pg_catalog, pg_temp/);
    expect(UP).toContain(`REVOKE ALL ON FUNCTION ${RECORD_FUNCTION_SIGNATURE} FROM PUBLIC`);
    expect(UP).toContain(`ALTER FUNCTION ${RECORD_FUNCTION_SIGNATURE} OWNER TO rab_secure_owner`);
    expect(UP).toContain(`REVOKE ALL ON FUNCTION ${RECORD_FUNCTION_SIGNATURE} FROM crewflow, crewflow_app`);
    expect(UP).not.toMatch(/GRANT EXECUTE/);
    expect(RELEASE_UPGRADE_LEDGER_EXPECTED_STATE.function_acl).toBe('release_upgrade_record:rab_secure_owner:EXECUTE:false');
  });

  it('the definer names only its own table and pg_catalog built-ins; no dynamic SQL; stamps time and login itself', () => {
    const tables = new Set([...DEFINER.matchAll(/\bcore\.([a-z_]+)/g)].map((m) => m[1]));
    expect([...tables].sort()).toEqual(['release_upgrade_event', 'release_upgrade_record']);
    expect(DEFINER).not.toMatch(/\bEXECUTE\b/);
    expect(DEFINER).toContain('v_login := session_user;');
    expect(DEFINER).toContain('pg_catalog.clock_timestamp()');
    expect(DEFINER).toMatch(/v_login IN \('crewflow', 'crewflow_app'\) OR NOT pg_catalog\.pg_has_role\(session_user, 'rab_secure_owner', 'MEMBER'\)/);
    expect(DEFINER).toContain(`regexp_replace(p_error_message, '(postgres(ql)?|rediss?)://[^[:space:]]+', '<url>', 'gi')`);
  });

  it('the event shape CHECK cannot be passed by NULLs (wrapped in IS TRUE)', () => {
    expect(UP).toMatch(/CONSTRAINT release_upgrade_event_shape CHECK \(\(\n\s+CASE event/);
    expect(UP).toMatch(/END\n\s+\) IS TRUE\)/);
  });

  it('down() drops exactly the function and the table', () => {
    expect(RELEASE_UPGRADE_LEDGER_DOWN_SQL).toEqual([`DROP FUNCTION ${RECORD_FUNCTION_SIGNATURE}`, 'DROP TABLE core.release_upgrade_event']);
  });

  it('the posture lists name the table: check-rls-coverage FORCED_NON_TENANT_TABLES and the boot gate FORCED_NON_TENANT', () => {
    const root = join(__dirname, '..', '..', '..', '..', '..', '..');
    expect(readFileSync(join(root, 'tools', 'check-rls-coverage.ts'), 'utf8')).toMatch(/FORCED_NON_TENANT_TABLES = \[[^\]]*'release_upgrade_event'/);
    expect(readFileSync(join(root, 'packages', 'rab-server', 'src', 'database', 'boot-checks', 'owner-login-posture.ts'), 'utf8')).toMatch(
      /FORCED_NON_TENANT = \[[^\]]*'release_upgrade_event'/,
    );
  });
});
