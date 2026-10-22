import { V1_EXPECTED, WORKSPACE_TABLES } from '../provision-workspace-schema';
import {
  composeServerPathTemplateV1,
  SERVER_PATH_EXPECTED_V1,
  SERVER_PATH_SENTINEL_SCHEMA,
  SERVER_PATH_TABLES_V1,
} from './server-path-template';

/**
 * Drift guard for server-path provisioning (proposed migration 1786719500000): the database function freezes the V1
 * template, the table list and the expected structural counts. If the TypeScript provisioner's V1_EXPECTED or
 * WORKSPACE_TABLES change (a new workspace-template migration), this fails until a new migration re-creates
 * core.provision_workspace with the new composition — the two provisioning paths must never build different schemas.
 */
describe('server-path provisioning template (frozen with 1786719500000)', () => {
  it('expected counts equal the TypeScript provisioner\'s V1_EXPECTED', () => {
    expect(SERVER_PATH_EXPECTED_V1).toEqual({ ...V1_EXPECTED });
  });

  it('table list equals WORKSPACE_TABLES, in order', () => {
    expect([...SERVER_PATH_TABLES_V1]).toEqual([...WORKSPACE_TABLES]);
  });

  it('the composed template targets only the sentinel schema and cannot break out of the function body', () => {
    const sql = composeServerPathTemplateV1();
    expect(sql).toContain(`${SERVER_PATH_SENTINEL_SCHEMA}.staff_profile`);
    expect(sql).not.toContain('__WS__');
    for (const tag of ['$template$', '$provision$', '$verify$']) expect(sql).not.toContain(tag);
    // Every CREATE TABLE targets the sentinel (later replaced by the derived, regex-checked name) — never core/public.
    const creates = sql.match(/CREATE TABLE\s+(?:IF NOT EXISTS\s+)?("?[\w]+"?)\./gi) ?? [];
    expect(creates.length).toBe(SERVER_PATH_EXPECTED_V1.tables);
    for (const c of creates) expect(c.replace(/"/g, '')).toContain(SERVER_PATH_SENTINEL_SCHEMA);
    expect(SERVER_PATH_SENTINEL_SCHEMA).toMatch(/^workspace_0{32}$/);
  });

  it('carries no transaction control or role switching (the function runs it inside the caller\'s transaction)', () => {
    const sql = composeServerPathTemplateV1();
    expect(sql).not.toMatch(/\b(BEGIN|COMMIT|ROLLBACK)\s*;/i);
    expect(sql).not.toMatch(/\bSET\s+(LOCAL\s+)?(ROLE|SESSION|search_path)\b/i);
    expect(sql).not.toMatch(/\bDISABLE ROW LEVEL SECURITY\b|\bNO FORCE ROW LEVEL SECURITY\b|\bBYPASSRLS\b/i);
    expect(sql).not.toMatch(/\bCONCURRENTLY\b/i);
  });
});
