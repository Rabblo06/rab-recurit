import { SchemaResolverService, workspaceSchemaName } from './schema-resolver.service';

describe('workspaceSchemaName (Phase 1 SchemaResolver)', () => {
  const WS_A = '11111111-1111-4111-8111-111111111111';
  // Derived inside PostgreSQL by core.provision_workspace_schema(uuid) on the migrated disposable DB.
  const WS_A_SCHEMA_FROM_DB = 'workspace_11111111111141118111111111111111';

  it('is deterministic for the same workspace id', () => {
    expect(workspaceSchemaName(WS_A)).toBe(workspaceSchemaName(WS_A));
  });

  it('matches the schema name PostgreSQL derives for the same UUID', () => {
    expect(workspaceSchemaName(WS_A)).toBe(WS_A_SCHEMA_FROM_DB);
  });

  it('canonicalises hyphen-less and upper-case input to the same name', () => {
    expect(workspaceSchemaName(WS_A.toUpperCase())).toBe(WS_A_SCHEMA_FROM_DB);
    expect(workspaceSchemaName(WS_A.replace(/-/g, ''))).toBe(WS_A_SCHEMA_FROM_DB);
  });

  it('always produces workspace_ + 32 lowercase hex, under the PostgreSQL identifier limit', () => {
    const name = workspaceSchemaName(WS_A);
    expect(name).toMatch(/^workspace_[0-9a-f]{32}$/);
    expect(name.length).toBe(42);
    expect(name.length).toBeLessThanOrEqual(63);
  });

  it.each([
    ['empty string', ''],
    ['not a uuid', 'issac'],
    ['schema name supplied as the id', 'workspace_11111111111141118111111111111111'],
    ['SQL injection attempt', "x'); DROP SCHEMA core CASCADE; --"],
    ['path-like traversal', '../../public'],
    ['public schema name', 'public'],
    ['uuid with extra characters', `${WS_A}x`],
    ['uuid with braces', `{${WS_A}}`],
    ['null', null],
    ['undefined', undefined],
    ['number', 42],
    ['object', { id: WS_A }],
  ])('rejects %s', (_label, value) => {
    expect(() => workspaceSchemaName(value as unknown as string)).toThrow();
  });

  it('never returns a name containing characters outside [a-z0-9_] for any accepted input', () => {
    for (const id of [WS_A, WS_A.toUpperCase(), WS_A.replace(/-/g, '')]) {
      expect(workspaceSchemaName(id)).toMatch(/^[a-z0-9_]+$/);
    }
  });
});

describe('SchemaResolverService', () => {
  it('delegates to the single canonical builder', () => {
    const service = new SchemaResolverService();
    expect(service.schemaFor('11111111-1111-4111-8111-111111111111')).toBe(
      'workspace_11111111111141118111111111111111',
    );
  });
});
