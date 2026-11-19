import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  METADATA_MIGRATION_CHANGE_KINDS,
  METADATA_MIGRATION_DOWN_SQL,
  METADATA_MIGRATION_EXPECTED_STATE,
  METADATA_MIGRATION_GUARD_FUNCTION_SQL,
  METADATA_MIGRATION_OWNERSHIP_SQL,
  METADATA_MIGRATION_TABLE_SQL,
  METADATA_MIGRATION_UP_SQL,
  metadataMigrationStateProblems,
} from './metadata-migration-log-sql';
import {
  DATA_MODEL_MANAGE_CATALOGUE_SQL,
  DATA_MODEL_MANAGE_GRANT_SQL,
  DATA_MODEL_MANAGE_REVOKE_SQL,
  SYSTEM_ROLE_DEFAULT_ADDITIONS_1786721630000,
} from './migrations/1786721630000-DataModelManagePermission';
import { migrationSourceViolations } from './migration-source-rules';

/**
 * Static review of the M2 phase 1 SQL: MetadataMigrationLog1786721640000 (S-1) and DataModelManagePermission1786721630000
 * (S-2). The database behaviour is proven in metadata-migration-log.integration.spec.ts and
 * data-model-permission.integration.spec.ts.
 */
describe('M2 phase 1 SQL: core.metadata_migration (S-1)', () => {
  const up = METADATA_MIGRATION_UP_SQL.join('\n');

  it('tenant columns NOT NULL, ENABLE + FORCE RLS and one tenant policy with USING and WITH CHECK, in the same migration', () => {
    expect(METADATA_MIGRATION_TABLE_SQL).toMatch(/organisation_id\s+uuid NOT NULL/);
    expect(METADATA_MIGRATION_TABLE_SQL).toMatch(/workspace_id\s+uuid NOT NULL/);
    expect(METADATA_MIGRATION_UP_SQL).toContain('ALTER TABLE core.metadata_migration ENABLE ROW LEVEL SECURITY');
    expect(METADATA_MIGRATION_UP_SQL).toContain('ALTER TABLE core.metadata_migration FORCE ROW LEVEL SECURITY');
    expect(up).toMatch(
      /CREATE POLICY metadata_migration_tenant ON core\.metadata_migration AS PERMISSIVE FOR ALL TO PUBLIC\s+USING \(organisation_id = core\.current_org\(\) AND workspace_id = core\.current_workspace\(\)\)\s+WITH CHECK \(organisation_id = core\.current_org\(\) AND workspace_id = core\.current_workspace\(\)\)/,
    );
    expect(up.match(/CREATE POLICY/g)).toHaveLength(1);
  });

  it('insert-only grants: crewflow_app SELECT + INSERT, nothing for PUBLIC, no UPDATE / DELETE / TRUNCATE grant anywhere', () => {
    expect(METADATA_MIGRATION_UP_SQL).toContain('REVOKE ALL ON TABLE core.metadata_migration FROM PUBLIC');
    expect(METADATA_MIGRATION_UP_SQL).toContain('GRANT SELECT, INSERT ON TABLE core.metadata_migration TO crewflow_app');
    expect(up.match(/\bGRANT\b/g)).toHaveLength(1);
    expect(up).not.toMatch(/GRANT[^;\n]*(UPDATE|DELETE|TRUNCATE)/);
    expect(METADATA_MIGRATION_EXPECTED_STATE.acl).toBe('crewflow_app:INSERT:false,crewflow_app:SELECT:false');
  });

  it('owner decisions 2026-11-18: workspace ON DELETE CASCADE; actor → core."user" ON DELETE SET NULL', () => {
    expect(METADATA_MIGRATION_TABLE_SQL).toContain(
      'CONSTRAINT metadata_migration_workspace_fkey FOREIGN KEY (workspace_id, organisation_id)\n    REFERENCES core.manager_workspace (id, organisation_id) ON DELETE CASCADE',
    );
    expect(METADATA_MIGRATION_TABLE_SQL).toContain('CONSTRAINT metadata_migration_actor_fkey FOREIGN KEY (actor_user_id)\n    REFERENCES core."user" (id) ON DELETE SET NULL');
    expect(METADATA_MIGRATION_TABLE_SQL).toMatch(/actor_user_id\s+uuid,/); // nullable: SET NULL must be able to clear it
    expect(METADATA_MIGRATION_EXPECTED_STATE.foreign_keys).toBe('metadata_migration_actor_fkey:core."user":n;metadata_migration_workspace_fkey:core.manager_workspace:c');
    expect(METADATA_MIGRATION_UP_SQL).toContain('CREATE INDEX metadata_migration_actor_idx ON core.metadata_migration (actor_user_id) WHERE actor_user_id IS NOT NULL');
  });

  it('bounded content: closed change kinds, a version step of exactly one, actions ≤ 32 objects / 8 KiB, a plain request id', () => {
    expect([...METADATA_MIGRATION_CHANGE_KINDS]).toHaveLength(13);
    for (const kind of METADATA_MIGRATION_CHANGE_KINDS) {
      expect(kind).toMatch(/^(object|field|option|index)\.[a-z]+$/);
      expect(METADATA_MIGRATION_TABLE_SQL).toContain(`'${kind}'`);
    }
    expect(METADATA_MIGRATION_CHANGE_KINDS).not.toContain('option.delete'); // Q5: narrowing / delete is M3
    expect(METADATA_MIGRATION_TABLE_SQL).toContain('CHECK (previous_version >= 1 AND metadata_version = previous_version + 1)');
    expect(METADATA_MIGRATION_TABLE_SQL).toContain('pg_catalog.jsonb_array_length(actions) <= 32');
    expect(METADATA_MIGRATION_TABLE_SQL).toContain('pg_catalog.octet_length(actions::text) <= 8192');
    expect(METADATA_MIGRATION_TABLE_SQL).toContain(`NOT pg_catalog.jsonb_path_exists(actions, '$[*] ? (@.type() != "object")')`);
    expect(METADATA_MIGRATION_TABLE_SQL).toContain("CHECK (request_id IS NULL OR request_id ~ '^[A-Za-z0-9._:-]{1,64}$')");
    expect(METADATA_MIGRATION_TABLE_SQL).toContain('CONSTRAINT metadata_migration_version_uq UNIQUE (workspace_id, metadata_version)');
  });

  it('the guard: SECURITY INVOKER, pinned search_path, PUBLIC revoked, row + TRUNCATE triggers, every refusal 42501', () => {
    expect(up).not.toMatch(/SECURITY\s+DEFINER/i);
    expect(METADATA_MIGRATION_GUARD_FUNCTION_SQL).toContain('SET search_path = pg_catalog, pg_temp');
    expect(METADATA_MIGRATION_UP_SQL).toContain('REVOKE ALL ON FUNCTION core.metadata_migration_guard() FROM PUBLIC');
    expect(METADATA_MIGRATION_UP_SQL).toContain(
      'CREATE TRIGGER metadata_migration_guard BEFORE INSERT OR UPDATE OR DELETE ON core.metadata_migration FOR EACH ROW EXECUTE FUNCTION core.metadata_migration_guard()',
    );
    expect(METADATA_MIGRATION_UP_SQL).toContain(
      'CREATE TRIGGER metadata_migration_truncate_guard BEFORE TRUNCATE ON core.metadata_migration FOR EACH STATEMENT EXECUTE FUNCTION core.metadata_migration_guard()',
    );
    expect(METADATA_MIGRATION_GUARD_FUNCTION_SQL.match(/ERRCODE = '42501'/g)).toHaveLength(5);
  });

  it('the guard: insert-only (depth 1 refused), the actor is the bound user, the version is this transaction’s own bump', () => {
    const fn = METADATA_MIGRATION_GUARD_FUNCTION_SQL;
    expect(fn).toContain('IF pg_catalog.pg_trigger_depth() < 2 THEN');
    expect(fn).toContain('IF NEW.actor_user_id IS DISTINCT FROM core.current_uid() THEN');
    expect(fn).toContain('AND s.last_bump_xact = pg_catalog.pg_current_xact_id()');
    expect(fn).toContain('AND s.metadata_version = NEW.metadata_version');
    expect(fn).toContain('NEW.created_at := pg_catalog.clock_timestamp();');
    // The one UPDATE that is ever applied (the actor's SET NULL) may change nothing else.
    expect(fn).toContain("(pg_catalog.to_jsonb(NEW) - 'actor_user_id') IS DISTINCT FROM (pg_catalog.to_jsonb(OLD) - 'actor_user_id')");
    // The insert branch returns before the depth test, so a direct INSERT is allowed and every direct UPDATE / DELETE is not.
    expect(fn.indexOf("IF TG_OP = 'INSERT' THEN")).toBeLessThan(fn.indexOf('pg_catalog.pg_trigger_depth() < 2'));
    expect(fn.indexOf('pg_catalog.pg_trigger_depth() < 2')).toBeLessThan(fn.indexOf("IF TG_OP = 'DELETE' THEN"));
  });

  it('ownership goes to crewflow inside withCrewflowCoreCreate; down() refuses rows and removes everything up() created', () => {
    expect(METADATA_MIGRATION_OWNERSHIP_SQL).toEqual(['ALTER TABLE core.metadata_migration OWNER TO crewflow', 'ALTER FUNCTION core.metadata_migration_guard() OWNER TO crewflow']);
    expect(METADATA_MIGRATION_DOWN_SQL).toEqual(['DROP TABLE core.metadata_migration', 'DROP FUNCTION core.metadata_migration_guard()']);
    const migration = readFileSync(join(__dirname, 'migrations', '1786721640000-MetadataMigrationLog.ts'), 'utf8');
    expect(migration).toContain('withCrewflowCoreCreate(queryRunner');
    expect(migration).toContain('METADATA_MIGRATION_DOWN_UNFORCE_SQL');
    expect(migration.indexOf('METADATA_MIGRATION_ROWS_SQL)')).toBeLessThan(migration.indexOf('for (const sql of METADATA_MIGRATION_DOWN_SQL)'));
    expect(migrationSourceViolations(migration)).toEqual([]);
  });

  it('state problems: the exact expected state passes, any drift is named', () => {
    expect(metadataMigrationStateProblems({ ...METADATA_MIGRATION_EXPECTED_STATE })).toEqual([]);
    expect(metadataMigrationStateProblems({ ...METADATA_MIGRATION_EXPECTED_STATE, force: false })).toEqual(['force: expected true, found false']);
    expect(metadataMigrationStateProblems(undefined)).toEqual(['core.metadata_migration: missing']);
  });
});

describe('M2 phase 1 SQL: data_model.manage (S-2)', () => {
  it('catalogue row data_model.manage (resource data_model, action manage), idempotent', () => {
    expect(DATA_MODEL_MANAGE_CATALOGUE_SQL).toBe(
      "INSERT INTO core.permission (key, resource, action) VALUES ('data_model.manage', 'data_model', 'manage') ON CONFLICT (key) DO NOTHING",
    );
  });

  it('defaults: the ceo and manager system roles only (owner decision 2026-11-18), organisation-level, never a workspace role', () => {
    expect(SYSTEM_ROLE_DEFAULT_ADDITIONS_1786721630000).toEqual({ ceo: ['data_model.manage'], manager: ['data_model.manage'] });
    expect(DATA_MODEL_MANAGE_GRANT_SQL).toContain("r.workspace_id IS NULL AND r.is_system AND r.key IN ('ceo', 'manager')");
    expect(DATA_MODEL_MANAGE_GRANT_SQL).not.toMatch(/venue_manager|'staff'/);
    expect(DATA_MODEL_MANAGE_GRANT_SQL).toContain('UPDATE core.role SET permission_version = permission_version + 1');
  });

  it('lists organisations through the definer keyset function (FORCE RLS on core.organisation), never a bare SELECT', () => {
    for (const sql of [DATA_MODEL_MANAGE_GRANT_SQL, DATA_MODEL_MANAGE_REVOKE_SQL]) {
      expect(sql).toContain('FROM core.worker_list_organisations(v_after, 100) l');
      expect(sql).not.toMatch(/FROM core\.organisation\b/);
      expect(sql).toContain("pg_catalog.set_config('rab.organisation_id', o.organisation_id::text, true)");
    }
  });

  it('review #252: both directions refuse a zero-organisation run while a second source says organisations exist', () => {
    for (const sql of [DATA_MODEL_MANAGE_GRANT_SQL, DATA_MODEL_MANAGE_REVOKE_SQL]) {
      expect(sql).toContain("IF v_orgs = 0 AND (pg_catalog.pg_stat_get_live_tuples('core.organisation'::pg_catalog.regclass) > 0");
      expect(sql).toContain('OR EXISTS (SELECT 1 FROM core.worker_list_workspaces(NULL, 1))) THEN');
      expect(sql).toMatch(/RAISE EXCEPTION 'DataModelManagePermission1786721630000( down\(\))?: the organisation lister returned no organisation/);
    }
  });

  it('review #252: down() bumps every role of an organisation that had a grant or a per-user override of the flag', () => {
    expect(DATA_MODEL_MANAGE_REVOKE_SQL).toContain('IF v_rows > 0 OR v_override THEN');
    expect(DATA_MODEL_MANAGE_REVOKE_SQL).toContain('UPDATE core.role SET permission_version = permission_version + 1 WHERE organisation_id = o.organisation_id;');
    expect(DATA_MODEL_MANAGE_REVOKE_SQL).toContain('FROM core.user_permission_override upo');
  });

  it('a per-organisation post-condition: every ceo / manager holds it and no other role does, else the migration fails', () => {
    expect(DATA_MODEL_MANAGE_GRANT_SQL).toContain('IF v_missing <> 0 OR v_other <> 0 THEN');
    expect(DATA_MODEL_MANAGE_GRANT_SQL).toMatch(/RAISE EXCEPTION 'DataModelManagePermission1786721630000: post-condition failed/);
  });

  it('the member allowlist trigger is untouched (custom workspace roles stay blocked, owner decision 2026-11-18)', () => {
    const migration = readFileSync(join(__dirname, 'migrations', '1786721630000-DataModelManagePermission.ts'), 'utf8');
    expect(migration).not.toMatch(/enforce_member_role_permission_allowlist\(\)\s+RETURNS|CREATE OR REPLACE FUNCTION|DROP TRIGGER/);
    expect(migrationSourceViolations(migration)).toEqual([]);
  });
});
