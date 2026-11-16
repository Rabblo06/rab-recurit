import {
  METADATA_VERSION_DOWN_SQL,
  METADATA_VERSION_EXPECTED_STATE,
  METADATA_VERSION_OWNERSHIP_SQL,
  METADATA_VERSION_UP_SQL,
  METADATA_VERSIONED_TABLES,
  metadataVersionStateProblems,
} from './metadata-version-sql';

/** Static review of MetadataVersionState1786721560000's SQL (the behaviour is proven in metadata-cache.integration.spec.ts). */
describe('metadata version SQL (M1 E5)', () => {
  const up = METADATA_VERSION_UP_SQL.join('\n');

  it('attaches exactly one AFTER ROW insert/update/delete bump trigger to each of the five cached tables', () => {
    expect([...METADATA_VERSIONED_TABLES]).toEqual(['object_metadata', 'field_metadata', 'field_metadata_option', 'index_metadata', 'index_field_metadata']);
    for (const t of METADATA_VERSIONED_TABLES) {
      const matches = METADATA_VERSION_UP_SQL.filter((s) => s.includes(` ON core.${t} `) && s.includes('core.metadata_version_bump()'));
      expect(matches).toEqual([`CREATE TRIGGER ${t}_version_bump AFTER INSERT OR UPDATE OR DELETE ON core.${t} FOR EACH ROW EXECUTE FUNCTION core.metadata_version_bump()`]);
    }
  });

  it('never uses SECURITY DEFINER, pins search_path, and revokes EXECUTE from PUBLIC on both functions', () => {
    expect(up).not.toMatch(/SECURITY\s+DEFINER/i);
    expect(up.match(/SET search_path = pg_catalog, pg_temp/g)).toHaveLength(2);
    expect(METADATA_VERSION_UP_SQL).toContain('REVOKE ALL ON FUNCTION core.metadata_version_bump() FROM PUBLIC');
    expect(METADATA_VERSION_UP_SQL).toContain('REVOKE ALL ON FUNCTION core.workspace_metadata_state_guard() FROM PUBLIC');
  });

  it('creates the table with FORCE RLS, a tenant policy with USING and WITH CHECK, and no app DELETE', () => {
    expect(METADATA_VERSION_UP_SQL).toContain('ALTER TABLE core.workspace_metadata_state ENABLE ROW LEVEL SECURITY');
    expect(METADATA_VERSION_UP_SQL).toContain('ALTER TABLE core.workspace_metadata_state FORCE ROW LEVEL SECURITY');
    expect(up).toMatch(/USING \(organisation_id = core\.current_org\(\) AND workspace_id = core\.current_workspace\(\)\)\s+WITH CHECK \(organisation_id = core\.current_org\(\) AND workspace_id = core\.current_workspace\(\)\)/);
    expect(METADATA_VERSION_UP_SQL).toContain('GRANT SELECT, INSERT, UPDATE ON TABLE core.workspace_metadata_state TO crewflow_app');
    expect(up).not.toMatch(/GRANT[^;]*DELETE[^;]*workspace_metadata_state/);
    expect(METADATA_VERSION_EXPECTED_STATE.acl).toBe('crewflow_app:INSERT:false,crewflow_app:SELECT:false,crewflow_app:UPDATE:false');
  });

  it('the bump is once per transaction (top-level xact id) and a DELETE never inserts the row', () => {
    expect(up).toContain('pg_catalog.pg_current_xact_id()');
    expect(up).toContain('s.last_bump_xact IS DISTINCT FROM v_xact');
    const fn = METADATA_VERSION_UP_SQL.find((s) => s.startsWith('CREATE FUNCTION core.metadata_version_bump()'))!;
    expect(fn.indexOf("IF TG_OP = 'DELETE' THEN\n    RETURN NULL;")).toBeLessThan(fn.indexOf('INSERT INTO core.workspace_metadata_state'));
  });

  it('the guard refuses every direct write, a non-1 insert, an identity change and any step other than +1', () => {
    const fn = METADATA_VERSION_UP_SQL.find((s) => s.startsWith('CREATE FUNCTION core.workspace_metadata_state_guard()'))!;
    expect(fn).toContain('pg_catalog.pg_trigger_depth() < 2');
    expect(fn).toContain('NEW.metadata_version <> OLD.metadata_version + 1');
    expect(fn).toContain('NEW.metadata_version <> 1');
    expect(fn.match(/ERRCODE = '42501'/g)).toHaveLength(4);
    expect(METADATA_VERSION_UP_SQL.some((s) => s.includes('workspace_metadata_state_guard BEFORE INSERT OR UPDATE OR DELETE'))).toBe(true);
  });

  it('ownership goes to crewflow; down() removes everything up() created', () => {
    expect(METADATA_VERSION_OWNERSHIP_SQL.every((s) => s.endsWith('OWNER TO crewflow'))).toBe(true);
    expect(METADATA_VERSION_DOWN_SQL).toHaveLength(METADATA_VERSIONED_TABLES.length + 3);
  });

  it('state problems: exact match passes, any drift is named', () => {
    expect(metadataVersionStateProblems({ ...METADATA_VERSION_EXPECTED_STATE })).toEqual([]);
    expect(metadataVersionStateProblems({ ...METADATA_VERSION_EXPECTED_STATE, force: false })).toEqual(['force: expected true, found false']);
    expect(metadataVersionStateProblems(undefined)).toEqual(['core.workspace_metadata_state: missing']);
  });
});
