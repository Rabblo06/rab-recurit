import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { CREWFLOW_INTERNAL_FIELD_METADATA_TYPES, FIELD_METADATA_TYPES } from '@rab/shared';

import {
  expectedTableState,
  METADATA_DOWN_UNFORCE_SQL,
  METADATA_GUARD_FUNCTION_SQL,
  METADATA_OWNERSHIP_SQL,
  METADATA_TABLES,
  METADATA_TABLES_DOWN_SQL,
  METADATA_TABLES_UP_SQL,
  metadataStateProblems,
  MetadataTableState,
  STORED_FIELD_TYPES,
  TENANT_PREDICATE,
} from './metadata-tables-sql';
import { migrationSourceViolations } from './migration-source-rules';

/**
 * Static checks of MetadataEngineTables1786721550000's SQL (metadata engine M1 / E1). The database behaviour is proven by
 * src/__tests__/integration/metadata-tables.integration.spec.ts on the InstaBox workers; this spec pins the reviewed text.
 */
const UP = METADATA_TABLES_UP_SQL.join(';\n');
const createOf = (t: string) => METADATA_TABLES_UP_SQL.find((s) => s.startsWith(`CREATE TABLE core.${t} (`)) ?? '';

describe('metadata tables SQL (MetadataEngineTables1786721550000)', () => {
  it("the type CHECK holds exactly Twenty's 25 field types plus the Crewflow-internal RANGE, as @rab/shared says", () => {
    expect(FIELD_METADATA_TYPES).toHaveLength(25);
    expect([...STORED_FIELD_TYPES].sort()).toEqual([...FIELD_METADATA_TYPES, ...CREWFLOW_INTERNAL_FIELD_METADATA_TYPES].sort());
    for (const t of STORED_FIELD_TYPES) expect(createOf('field_metadata')).toContain(`'${t}'`);
    expect(createOf('field_metadata')).toContain("CHECK (type <> 'MORPH_RELATION')");
  });

  it.each(METADATA_TABLES.map((t) => [t]))('%s: tenant columns, tenant FK, ENABLE + FORCE, one USING + WITH CHECK policy and the grants, in this migration', (t) => {
    const create = createOf(t);
    expect(create).toMatch(/\n {2}organisation_id uuid NOT NULL,\n {2}workspace_id uuid NOT NULL,/);
    expect(create).toContain(`CONSTRAINT ${t}_workspace_fkey FOREIGN KEY (workspace_id, organisation_id)\n    REFERENCES core.manager_workspace (id, organisation_id) ON DELETE CASCADE`);
    expect(METADATA_TABLES_UP_SQL).toContain(`ALTER TABLE core.${t} ENABLE ROW LEVEL SECURITY`);
    expect(METADATA_TABLES_UP_SQL).toContain(`ALTER TABLE core.${t} FORCE ROW LEVEL SECURITY`);
    const policies = METADATA_TABLES_UP_SQL.filter((s) => s.startsWith('CREATE POLICY') && s.includes(` ON core.${t} `));
    expect(policies).toEqual([`CREATE POLICY ${t}_tenant ON core.${t} AS PERMISSIVE FOR ALL TO PUBLIC\n  USING (${TENANT_PREDICATE})\n  WITH CHECK (${TENANT_PREDICATE})`]);
    expect(METADATA_TABLES_UP_SQL).toContain(`REVOKE ALL ON TABLE core.${t} FROM PUBLIC`);
    expect(METADATA_TABLES_UP_SQL).toContain(`GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE core.${t} TO crewflow_app`);
    expect(METADATA_TABLES_UP_SQL).toContain(`CREATE TRIGGER ${t}_truncate_guard BEFORE TRUNCATE ON core.${t} FOR EACH STATEMENT EXECUTE FUNCTION core.metadata_guard()`);
    expect(METADATA_OWNERSHIP_SQL).toContain(`ALTER TABLE core.${t} OWNER TO crewflow`);
    expect(METADATA_DOWN_UNFORCE_SQL).toContain(`ALTER TABLE core.${t} NO FORCE ROW LEVEL SECURITY`);
    expect(METADATA_TABLES_DOWN_SQL).toContain(`DROP TABLE core.${t}`);
  });

  it('never weakens anything: no DISABLE / NO FORCE / BYPASSRLS / SECURITY DEFINER / grant to PUBLIC / role change in up()', () => {
    expect(UP).not.toMatch(/DISABLE\s+ROW\s+LEVEL|NO\s+FORCE|BYPASSRLS|SECURITY\s+DEFINER|\bGRANT\b[^;]*\bTO\s+PUBLIC\b|\bALTER\s+ROLE\b|\bCREATE\s+ROLE\b|\bTRUNCATE\s+core\./i);
    expect(UP).not.toMatch(/\bGRANT\b[^;]*\bTO\s+crewflow\b(?!_)/i); // crewflow is the owner, never a grantee here
    expect(METADATA_GUARD_FUNCTION_SQL).toContain('SET search_path = pg_catalog, pg_temp');
    expect(METADATA_GUARD_FUNCTION_SQL).not.toMatch(/\bEXECUTE\s+(?!FUNCTION)/i); // no dynamic SQL in the guard
    expect(METADATA_OWNERSHIP_SQL).toContain('ALTER FUNCTION core.metadata_guard() OWNER TO crewflow');
    expect(METADATA_TABLES_UP_SQL).toContain('REVOKE ALL ON FUNCTION core.metadata_guard() FROM PUBLIC');
  });

  it('the guard: immutable columns, the lock rule, the delete rule (depth 1 only) and the two INSERT refusals are all present', () => {
    for (const col of ['physical_table', 'storage', 'name_singular', 'name_plural', 'physical_column', 'type', 'object_metadata_id', 'is_money', 'relation_target_object_metadata_id', 'universal_identifier']) {
      expect(METADATA_GUARD_FUNCTION_SQL).toContain(`NEW.${col} IS DISTINCT FROM OLD.${col}`);
    }
    expect(METADATA_GUARD_FUNCTION_SQL).toContain('(OLD.is_locked AND NOT NEW.is_locked)');
    expect(METADATA_GUARD_FUNCTION_SQL).toContain('pg_trigger_depth() = 1');
    expect(METADATA_GUARD_FUNCTION_SQL).toContain("CONSTRAINT = 'field_metadata_custom_fields_allowed'");
    expect(METADATA_GUARD_FUNCTION_SQL).toContain("CONSTRAINT = 'field_metadata_currency_custom_object_only'");
    // error messages carry no input values (MT-04)
    expect(METADATA_GUARD_FUNCTION_SQL).not.toMatch(/RAISE EXCEPTION '[^']*%/);
  });

  it('the migration and its SQL module pass the post-Phase-0b source rules', () => {
    const migration = readFileSync(join(__dirname, 'migrations', '1786721550000-MetadataEngineTables.ts'), 'utf8');
    const sqlModule = readFileSync(join(__dirname, 'metadata-tables-sql.ts'), 'utf8');
    expect(migrationSourceViolations(migration)).toEqual([]);
    expect(migrationSourceViolations(sqlModule).filter((v) => !v.includes('withCrewflowCoreCreate'))).toEqual([]);
    expect(migration).toMatch(/withCrewflowCoreCreate\(queryRunner/); // the OWNER TO crewflow hand-over runs inside the window
  });

  it('the post-condition accepts exactly the reviewed state and names every difference', () => {
    const rows: MetadataTableState[] = METADATA_TABLES.map((t) => expectedTableState(t));
    const fn = { owner: 'crewflow', definer: false, config: 'search_path=pg_catalog, pg_temp', app_execute: false, public_revoked: true };
    expect(metadataStateProblems(rows, fn)).toEqual([]);
    const drifted = rows.map((r) => (r.tbl === 'field_metadata' ? { ...r, force: false, acl: `${r.acl},PUBLIC:SELECT:false` } : r));
    expect(metadataStateProblems(drifted, { ...fn, definer: true })).toEqual([
      'core.field_metadata.force: expected true, found false',
      'core.field_metadata.acl: expected "crewflow_app:DELETE:false,crewflow_app:INSERT:false,crewflow_app:SELECT:false,crewflow_app:UPDATE:false", found "crewflow_app:DELETE:false,crewflow_app:INSERT:false,crewflow_app:SELECT:false,crewflow_app:UPDATE:false,PUBLIC:SELECT:false"',
      'core.metadata_guard().definer: expected false, found true',
    ]);
    expect(metadataStateProblems(rows.slice(1), undefined)).toEqual(['core.object_metadata: missing','expected 5 metadata tables, found 4', 'core.metadata_guard(): missing']);
    expect(expectedTableState('object_metadata').triggers).toBe('object_metadata_guard:O:core.metadata_guard();object_metadata_truncate_guard:O:core.metadata_guard()');
    expect(expectedTableState('index_metadata').triggers).toBe('index_metadata_truncate_guard:O:core.metadata_guard()');
  });
});
