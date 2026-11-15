import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { CREWFLOW_INTERNAL_FIELD_METADATA_TYPES, FIELD_METADATA_TYPES } from '@rab/shared';
import { QueryRunner } from 'typeorm';

import {
  expectedTableState,
  INVISIBLE_CHARACTERS_CLASS,
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
  UNIVERSAL_IDENTIFIER_KIND_PREDICATE,
} from './metadata-tables-sql';
import { migrationSourceViolations } from './migration-source-rules';
import { MetadataEngineTables1786721550000 } from './migrations/1786721550000-MetadataEngineTables';

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

  it('owner batch 11 (Twenty syncable-entity alignment): every object / field row has a universal identifier, unique per workspace; custom = v4, built-in = v8', () => {
    expect(UNIVERSAL_IDENTIFIER_KIND_PREDICATE).toBe("pg_catalog.substr(universal_identifier::text, 15, 1) = CASE WHEN is_custom THEN '4' ELSE '8' END");
    for (const t of ['object_metadata', 'field_metadata']) {
      const create = createOf(t);
      expect(create).toContain('\n  universal_identifier uuid NOT NULL DEFAULT pg_catalog.gen_random_uuid(),\n');
      expect(create).toContain(`CONSTRAINT ${t}_universal_identifier_kind_ck CHECK (${UNIVERSAL_IDENTIFIER_KIND_PREDICATE})`);
      // one unique index per table, over every row (no partial predicate left, no duplicate index)
      const uniques = METADATA_TABLES_UP_SQL.filter((s) => s.startsWith('CREATE UNIQUE INDEX') && s.includes(`ON core.${t} `) && s.includes('universal_identifier'));
      expect(uniques).toEqual([`CREATE UNIQUE INDEX ${t}_universal_identifier_uq ON core.${t} (workspace_id, universal_identifier)`]);
    }
    // the replaced rules are gone: custom rows no longer refuse an identifier, built-in presence is the NOT NULL + v8 rule
    expect(UP).not.toContain('field_metadata_custom_no_universal_identifier_ck');
    expect(UP).not.toMatch(/universal_identifier IS (NOT )?NULL/);
    // the other three tables are not synced by identifier and have no such column
    for (const t of ['field_metadata_option', 'index_metadata', 'index_field_metadata']) expect(createOf(t)).not.toContain('universal_identifier');
  });

  it('relation CHECKs never pass on a missing relationType (NULL IN (...) is NULL, which a CHECK accepts)', () => {
    const create = createOf('field_metadata');
    expect(create).toContain("COALESCE(settings ->> 'relationType', '') IN ('MANY_TO_ONE', 'ONE_TO_MANY')");
    expect(create).toContain("COALESCE(settings ->> 'relationType', '') = 'ONE_TO_MANY') = (physical_column IS NULL)");
    expect(create).not.toMatch(/[^(]settings ->> 'relationType' (IN|=)/);
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

  it('review #165: identity split, fail-closed parent lookups FOR SHARE, payroll pinned to system, core-reference allowlist, invisible characters', () => {
    const g = METADATA_GUARD_FUNCTION_SQL;
    expect(g).toContain("v_privileged boolean := current_user IN ('crewflow'::name, 'rab_secure_owner'::name)");
    expect(g.match(/AND NOT v_privileged THEN/g)?.length).toBeGreaterThanOrEqual(4);
    expect(g.match(/FOR SHARE;/g)).toHaveLength(6);
    expect(g).toContain('(NOT NEW.is_custom OR NEW.is_locked OR NEW.is_system) AND NOT v_privileged'); // N2
    expect(g).toContain("USING ERRCODE = '23503', CONSTRAINT = 'index_metadata_object_fkey'"); // N1
    expect(g).toContain('NEW.is_active IS DISTINCT FROM OLD.is_active AND NOT v_privileged'); // N1
    expect(METADATA_TABLES_UP_SQL).toContain('CREATE TRIGGER index_metadata_guard BEFORE INSERT OR UPDATE OR DELETE ON core.index_metadata FOR EACH ROW EXECUTE FUNCTION core.metadata_guard()');
    for (const c of ['field_metadata_object_fkey', 'field_metadata_option_field_fkey', 'index_field_metadata_field_fkey']) {
      expect(g).toContain(`USING ERRCODE = '23503', CONSTRAINT = '${c}'`);
    }
    expect(g).toContain("RAISE EXCEPTION 'metadata_guard: unexpected table'");
    // TRUNCATE follows the identity rule: refused for the request path only (test teardowns truncate as the superuser).
    expect(g).toContain("IF TG_OP = 'TRUNCATE' THEN\n    IF NOT v_privileged THEN");
    for (const t of METADATA_TABLES) expect(METADATA_TABLES_UP_SQL.some((x) => x.startsWith(`CREATE TRIGGER ${t}_guard BEFORE `))).toBe(true);
    const objects = createOf('object_metadata');
    expect(objects).toContain(`physical_table NOT IN ('attendance', 'attendance_correction', 'payroll_record', 'payroll_run', 'payroll_run_line', 'payslip', 'payslip_document')`);
    expect(objects).toContain("OR (is_system AND NOT allows_custom_fields))");
    expect(objects).toContain("physical_table IN ('user', 'manager_profile', 'stored_file', 'payroll_calendar_period')");
    for (const t of METADATA_TABLES.filter((x) => x !== 'index_metadata' && x !== 'index_field_metadata')) {
      expect(createOf(t)).toContain(`!~ '${INVISIBLE_CHARACTERS_CLASS}'`);
    }
  });

  it('L3: up() and down() refuse to run outside a transaction, before any statement', async () => {
    const query = jest.fn();
    const migration = new MetadataEngineTables1786721550000();
    const runner = { isTransactionActive: false, query } as unknown as QueryRunner;
    await expect(migration.up(runner)).rejects.toThrow(/outside a transaction/);
    await expect(migration.down(runner)).rejects.toThrow(/outside a transaction/);
    expect(query).not.toHaveBeenCalled();
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
    expect(expectedTableState('index_metadata').triggers).toBe('index_metadata_guard:O:core.metadata_guard();index_metadata_truncate_guard:O:core.metadata_guard()');
  });
});
