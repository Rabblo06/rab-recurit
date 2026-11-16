/**
 * Metadata engine M1 / E1 (OWNER-METADATA-ENGINE.md §1 E1; M0-TEST-STRATEGY.md §2 M1 "RLS (new core tables)"): the five
 * metadata tables of MetadataEngineTables1786721550000 on the real disposable test database (migrations alone, owner-login
 * bootstrap). Checks run over the runtime login's own connection (TEST_DATABASE_URL = crewflow_owner, NOBYPASSRLS, bound by
 * FORCE RLS); fixtures are committed by the cluster superuser (TEST_DATABASE_ADMIN_URL) and removed with their organisations.
 * Every mutation the runtime login attempts runs in a transaction that is rolled back. No URL or password is ever printed.
 *
 *   MD-1   catalog: ENABLE + FORCE, the one tenant policy (USING = WITH CHECK), owner crewflow, crewflow_app S/I/U/D only,
 *          nothing for PUBLIC, tenant columns NOT NULL, the guard triggers enabled.
 *   MD-2   no tenant context bound → zero rows from every table while rows exist (CLAUDE.md testing floor).
 *   MT-07  a workspace sees only its own metadata (same API names in three workspaces of two organisations); a foreign
 *          organisation / workspace binding sees nothing; WITH CHECK refuses rows for another tenant.
 *   MD-3   composite FKs: no cross-workspace object / field / option / index / relation / label-identifier reference.
 *   MT-26  the guard: physical names, type, kind flags and API names never change; a lock never comes off; locked /
 *          standard / system rows are never deleted directly; the cascades still work.
 *   MD-4   §0.3 / §0.5 at INSERT: no custom field where not allowed; CURRENCY on custom objects only; MORPH_RELATION and
 *          a custom RANGE refused; money only on a locked, sensitive, read-only built-in NUMBER; identifier patterns.
 *   MD-5   TRUNCATE refused to the request path on all five tables (also through TRUNCATE core.manager_workspace
 *          CASCADE); the superuser (test teardowns) may truncate.
 *   #165   security review: identity split (the request path cannot loosen built-in / locked metadata, options or index
 *          fields; SET LOCAL ROLE crewflow can), immutable index definitions, fail-closed parent lookups (L1), FOR SHARE
 *          (L2), payroll / attendance pinned to system (M1), core-reference allowlist (I1), no bidi / zero-width labels (I3).
 *   MD-6   deleting a workspace removes exactly its metadata (FK cascade through the delete guard).
 *   MD-7   MetadataReadService reads only the bound workspace and refuses without a binding.
 *   MD-8   tools/check-rls-coverage.ts passes as crewflow_owner with the tables present.
 *   MD-9   owner batch 11 (Twenty syncable-entity alignment): every object / field row has a universal identifier, unique
 *          per workspace; custom rows get a generated version-4 UUID, built-in rows the sync's version-8 UUID.
 *   MD-10  owner batch 11, condition 2: on the REAL request path (TenantContextService.runInTenantContext over a pooled
 *          crewflow_owner DataSource) the bound workspace's rows are read / written, nothing without a binding, and nothing
 *          of another workspace (read, update, delete or insert).
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { Client } from 'pg';
import { DataSource, EntityManager } from 'typeorm';

import { resolveIntegrationTestDatabase } from '../../database/typeorm/core/test-database-guard';
import { METADATA_TABLES, TENANT_PREDICATE } from '../../database/typeorm/core/metadata-tables-sql';
import { EnvironmentService } from '../../engine/core-modules/environment/environment.service';
import { AuthContext } from '../../engine/core-modules/tenant/auth-context.interface';
import { SchemaResolverService } from '../../engine/core-modules/tenant/schema-resolver.service';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import * as metadataEntities from '../../engine/metadata/entities';
import { MetadataContextError, MetadataReadService } from '../../engine/metadata/services/metadata-read.service';

jest.setTimeout(300_000);

const REPO_ROOT = join(__dirname, '..', '..', '..', '..', '..');
const MIGRATION_ON_BRANCH = existsSync(join(__dirname, '..', '..', 'database', 'typeorm', 'core', 'migrations', '1786721550000-MetadataEngineTables.ts'));
const env = resolveIntegrationTestDatabase(process.env);
const OWNER_URL = env.appUrl;
const ADMIN_URL = env.adminUrl;
const loginOf = (url: string) => {
  try {
    return decodeURIComponent(new URL(url).username);
  } catch {
    return '';
  }
};
// I-2: with the migration on the branch, a runtime login other than crewflow_owner is a CI misconfiguration, never a skip
// (same rule as integrationTestDatabaseReady: fail loudly, so MD-1 … MD-10 can never drop out silently). Never prints a URL.
if (MIGRATION_ON_BRANCH && loginOf(OWNER_URL) !== 'crewflow_owner') {
  throw new Error('metadata-tables spec: TEST_DATABASE_URL must be the runtime login crewflow_owner (MetadataEngineTables1786721550000 is on this branch)');
}
const RUN = MIGRATION_ON_BRANCH;
const describeIfMetadata = RUN ? describe : describe.skip;
const RUN_ID = randomBytes(4).toString('hex');

async function withClient<T>(url: string, fn: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: url, application_name: 'metadata-tables-spec' });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}
const asAdmin = <T>(fn: (c: Client) => Promise<T>) => withClient(ADMIN_URL, fn);
const asOwner = <T>(fn: (c: Client) => Promise<T>) => withClient(OWNER_URL, fn);

async function rolledBack<T>(c: Client, fn: () => Promise<T>): Promise<T> {
  await c.query('BEGIN');
  try {
    return await fn();
  } finally {
    await c.query('ROLLBACK');
  }
}

/** `sql` inside a savepoint: the SQLSTATE (null = succeeded), the violated constraint, the row count. */
async function attempt(c: Client, sql: string, params: unknown[] = []): Promise<{ code: string | null; constraint: string | null; rowCount: number }> {
  await c.query('SAVEPOINT md_try');
  try {
    const r = await c.query(sql, params);
    await c.query('RELEASE SAVEPOINT md_try');
    return { code: null, constraint: null, rowCount: r.rowCount ?? 0 };
  } catch (e) {
    await c.query('ROLLBACK TO SAVEPOINT md_try');
    const err = e as { code?: string; constraint?: string };
    return { code: err.code ?? 'unknown', constraint: err.constraint ?? null, rowCount: 0 };
  }
}

/** TenantContextService's request binding (tenant-context.service.ts bindGucsSql), transaction-local. */
const BIND_SQL =
  "SELECT set_config('rab.organisation_id', $1, true), set_config('rab.workspace_id', $2, true), set_config('rab.user_id', $3, true), set_config('rab.role', 'ceo', true), set_config('rab.actor_type', 'user', true)";

interface Ws {
  tag: string;
  org: string;
  user: string;
  workspace: string;
  /** ids of the seeded rows */
  staff: string;
  staffId: string;
  staffRef: string;
  staffStatus: string;
  staffPay: string;
  staffUser: string;
  payroll: string;
  payrollId: string;
  member: string;
  memberId: string;
  equipment: string;
  equipmentId: string;
  equipmentName: string;
  equipmentSerial: string;
  equipmentIndex: string;
}

/** Fixed universal identifiers: the same standard objects in every workspace, like the E2 sync (version 8, its namespace). */
const UID = {
  staff: '0b9a0c1e-0000-8000-8000-000000000001',
  staffId: '0b9a0c1e-0000-8000-8000-000000000002',
  staffRef: '0b9a0c1e-0000-8000-8000-000000000003',
  staffStatus: '0b9a0c1e-0000-8000-8000-000000000004',
  staffPay: '0b9a0c1e-0000-8000-8000-000000000005',
  staffUser: '0b9a0c1e-0000-8000-8000-000000000006',
  payroll: '0b9a0c1e-0000-8000-8000-000000000007',
  payrollId: '0b9a0c1e-0000-8000-8000-000000000008',
  member: '0b9a0c1e-0000-8000-8000-000000000009',
  memberId: '0b9a0c1e-0000-8000-8000-00000000000a',
};

const OBJECT_COLUMNS = ['id', 'organisation_id', 'workspace_id', 'universal_identifier', 'storage', 'name_singular', 'name_plural', 'label_singular', 'label_plural', 'physical_table', 'is_custom', 'is_system', 'allows_custom_fields', 'label_identifier_field_id'] as const;
const FIELD_COLUMNS = ['id', 'organisation_id', 'workspace_id', 'object_metadata_id', 'universal_identifier', 'type', 'name', 'label', 'physical_column', 'settings', 'is_custom', 'is_system', 'is_locked', 'is_ui_read_only', 'is_money', 'is_sensitive', 'relation_target_object_metadata_id', 'relation_target_field_metadata_id'] as const;
type ObjectRow = Partial<Record<(typeof OBJECT_COLUMNS)[number], unknown>>;
type FieldRow = Partial<Record<(typeof FIELD_COLUMNS)[number], unknown>>;

const insertSql = (table: string, columns: readonly string[]) =>
  `INSERT INTO core.${table} (${columns.join(', ')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})`;
/** universal_identifier absent from the row => absent from the INSERT, so the column DEFAULT (a version-4 UUID) applies. */
const withoutAbsentUid = <K extends string>(columns: readonly K[], row: Partial<Record<K, unknown>>) =>
  columns.filter((k) => k !== 'universal_identifier' || 'universal_identifier' in row);
const objectInsert = (row: ObjectRow): [string, unknown[]] => {
  const full: ObjectRow = { id: randomUUID(), storage: 'workspace', is_system: false, allows_custom_fields: false, label_identifier_field_id: null, ...row };
  const columns = withoutAbsentUid(OBJECT_COLUMNS, full);
  return [insertSql('object_metadata', columns), columns.map((k) => full[k] ?? null)];
};
const fieldInsert = (row: FieldRow): [string, unknown[]] => {
  const full: FieldRow = { id: randomUUID(), settings: {}, is_system: false, is_locked: false, is_ui_read_only: false, is_money: false, is_sensitive: false, ...row };
  if (typeof full.settings === 'object') full.settings = JSON.stringify(full.settings);
  const columns = withoutAbsentUid(FIELD_COLUMNS, full);
  return [insertSql('field_metadata', columns), columns.map((k) => full[k] ?? null)];
};
/** A version-8 UUID: the built-in namespace (the E2 sync derives its identifiers as version 8; custom rows are version 4). */
const v8 = () => {
  const u = randomUUID();
  return `${u.slice(0, 14)}8${u.slice(15)}`;
};

describeIfMetadata('metadata engine E1: the five metadata tables, FORCE RLS, the guard (MetadataEngineTables1786721550000)', () => {
  const orgs: string[] = [];
  let A1: Ws;
  let A2: Ws;
  let B1: Ws;

  async function createOrg(tag: string): Promise<string> {
    return asAdmin(async (c) => {
      const slug = `md-e1-${RUN_ID}-${tag}`;
      const org = (await c.query<{ id: string }>('INSERT INTO core.organisation (name, slug) VALUES ($1, $2) RETURNING id::text', [`MD E1 ${tag}`, slug])).rows[0]!.id;
      orgs.push(org);
      return org;
    });
  }

  /** A workspace with: staffProfile (standard), payrollRecord (system), workspaceMember (core reference), equipment (custom). */
  async function seedWorkspace(org: string, tag: string): Promise<Ws> {
    return asAdmin(async (c) => {
      const slug = `md-e1-${RUN_ID}-${tag}`;
      const user = (
        await c.query<{ id: string }>(
          "INSERT INTO core.\"user\" (organisation_id, email, password_hash, first_name, last_name, status) VALUES ($1, $2, '$argon2id$v=19$m=19456,t=2,p=1$bWRlMXNhbHRtZGUxc2FsdA$bWQtZTEtbm90LWEtcmVhbC1oYXNoLTAwMDAwMDAwMDA', 'MD', 'E1', 'active') RETURNING id::text",
          [org, `owner-${slug}@md-e1.invalid`],
        )
      ).rows[0]!.id;
      const workspace = (
        await c.query<{ id: string }>("INSERT INTO core.manager_workspace (organisation_id, owner_user_id, name, subdomain, status) VALUES ($1, $2, $3, $4, 'active') RETURNING id::text", [
          org,
          user,
          `MD E1 ${tag}`,
          slug,
        ])
      ).rows[0]!.id;
      const t = { organisation_id: org, workspace_id: workspace };
      const ids = {
        staff: randomUUID(), staffId: randomUUID(), staffRef: randomUUID(), staffStatus: randomUUID(), staffPay: randomUUID(), staffUser: randomUUID(),
        payroll: randomUUID(), payrollId: randomUUID(), member: randomUUID(), memberId: randomUUID(),
        equipment: randomUUID(), equipmentId: randomUUID(), equipmentName: randomUUID(), equipmentSerial: randomUUID(), equipmentIndex: randomUUID(),
      };
      const custom = randomBytes(6).toString('hex');
      await c.query('BEGIN');
      const run = async ([sql, params]: [string, unknown[]]) => c.query(sql, params);
      // Objects first (label identifiers are DEFERRABLE INITIALLY DEFERRED, checked at COMMIT).
      await run(objectInsert({ ...t, id: ids.staff, universal_identifier: UID.staff, name_singular: 'staffProfile', name_plural: 'staffProfiles', label_singular: 'Staff member', label_plural: 'Staff', physical_table: 'staff_profile', is_custom: false, allows_custom_fields: true, label_identifier_field_id: ids.staffRef }));
      await run(objectInsert({ ...t, id: ids.payroll, universal_identifier: UID.payroll, name_singular: 'payrollRecord', name_plural: 'payrollRecords', label_singular: 'Payroll record', label_plural: 'Payroll records', physical_table: 'payroll_record', is_custom: false, is_system: true }));
      await run(objectInsert({ ...t, id: ids.member, universal_identifier: UID.member, storage: 'core_reference', name_singular: 'workspaceMember', name_plural: 'workspaceMembers', label_singular: 'Member', label_plural: 'Members', physical_table: 'user', is_custom: false, is_system: true }));
      await run(objectInsert({ ...t, id: ids.equipment, name_singular: 'equipment', name_plural: 'equipments', label_singular: 'Equipment', label_plural: 'Equipment', physical_table: `c_${custom}`, is_custom: true, allows_custom_fields: true, label_identifier_field_id: ids.equipmentName }));
      const builtin = { ...t, is_custom: false, is_locked: true };
      await run(fieldInsert({ ...builtin, id: ids.staffId, object_metadata_id: ids.staff, universal_identifier: UID.staffId, type: 'UUID', name: 'id', label: 'Id', physical_column: 'id', is_system: true }));
      await run(fieldInsert({ ...builtin, id: ids.staffRef, object_metadata_id: ids.staff, universal_identifier: UID.staffRef, type: 'TEXT', name: 'staffRef', label: 'Staff ref', physical_column: 'staff_ref' }));
      await run(fieldInsert({ ...builtin, id: ids.staffStatus, object_metadata_id: ids.staff, universal_identifier: UID.staffStatus, type: 'SELECT', name: 'employmentStatus', label: 'Employment status', physical_column: 'employment_status', is_ui_read_only: true }));
      await run(fieldInsert({ ...builtin, id: ids.staffPay, object_metadata_id: ids.staff, universal_identifier: UID.staffPay, type: 'NUMBER', name: 'defaultPayRatePence', label: 'Default pay rate', physical_column: 'default_pay_rate_pence', is_money: true, is_sensitive: true, is_ui_read_only: true, settings: { dataType: 'bigint', unit: 'pence' } }));
      await run(fieldInsert({ ...builtin, id: ids.staffUser, object_metadata_id: ids.staff, universal_identifier: UID.staffUser, type: 'RELATION', name: 'user', label: 'User', physical_column: 'user_id', is_ui_read_only: true, relation_target_object_metadata_id: ids.member, settings: { relationType: 'MANY_TO_ONE', onDelete: 'CASCADE' } }));
      await run(fieldInsert({ ...builtin, id: ids.payrollId, object_metadata_id: ids.payroll, universal_identifier: UID.payrollId, type: 'UUID', name: 'id', label: 'Id', physical_column: 'id', is_system: true }));
      await run(fieldInsert({ ...builtin, id: ids.memberId, object_metadata_id: ids.member, universal_identifier: UID.memberId, type: 'UUID', name: 'id', label: 'Id', physical_column: 'id', is_system: true }));
      await run(fieldInsert({ ...builtin, id: ids.equipmentId, object_metadata_id: ids.equipment, universal_identifier: v8(), type: 'UUID', name: 'id', label: 'Id', physical_column: 'id', is_system: true }));
      await run(fieldInsert({ ...t, id: ids.equipmentName, object_metadata_id: ids.equipment, type: 'TEXT', name: 'name', label: 'Name', physical_column: `cf_${custom}a`, is_custom: true }));
      await run(fieldInsert({ ...t, id: ids.equipmentSerial, object_metadata_id: ids.equipment, type: 'TEXT', name: 'serialNumber', label: 'Serial number', physical_column: `cf_${custom}b`, is_custom: true }));
      for (const [value, pos] of [['active', 0], ['pending_compliance', 1]] as const) {
        await c.query('INSERT INTO core.field_metadata_option (organisation_id, workspace_id, field_metadata_id, value, label, position) VALUES ($1, $2, $3, $4, $5, $6)', [org, workspace, ids.staffStatus, value, value, pos]);
      }
      await c.query('INSERT INTO core.index_metadata (id, organisation_id, workspace_id, object_metadata_id, physical_name, is_unique) VALUES ($1, $2, $3, $4, $5, true)', [ids.equipmentIndex, org, workspace, ids.equipment, `ix_${custom}`]);
      await c.query('INSERT INTO core.index_field_metadata (organisation_id, workspace_id, index_metadata_id, object_metadata_id, field_metadata_id, position) VALUES ($1, $2, $3, $4, $5, 0)', [org, workspace, ids.equipmentIndex, ids.equipment, ids.equipmentSerial]);
      await c.query('COMMIT');
      return { tag, org, user, workspace, ...ids };
    });
  }

  const countsOf = (ws: string) =>
    asAdmin(async (c) => {
      const out: Record<string, number> = {};
      for (const t of METADATA_TABLES) out[t] = (await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM core.${t} WHERE workspace_id = $1`, [ws])).rows[0]!.n;
      return out;
    });

  /** As the runtime login, bound to (org, workspace, user), in a rolled-back transaction. */
  const bound = <T>(ws: Pick<Ws, 'org' | 'workspace' | 'user'>, fn: (c: Client) => Promise<T>) =>
    asOwner((c) =>
      rolledBack(c, async () => {
        await c.query(BIND_SQL, [ws.org, ws.workspace, ws.user]);
        return fn(c);
      }),
    );

  /** As the sync / executor identity: the runtime login, bound, then SET LOCAL ROLE crewflow (review #165 M2). */
  const boundAsCrewflow = <T>(ws: Pick<Ws, 'org' | 'workspace' | 'user'>, fn: (c: Client) => Promise<T>) =>
    bound(ws, async (c) => {
      await c.query('SET LOCAL ROLE crewflow');
      return fn(c);
    });

  beforeAll(async () => {
    const exists = await asAdmin(async (c) => (await c.query<{ ok: boolean }>("SELECT to_regclass('core.object_metadata') IS NOT NULL AS ok")).rows[0]!.ok);
    if (!exists) throw new Error('core.object_metadata does not exist on the test database (MetadataEngineTables1786721550000 did not run)');
    const orgA = await createOrg('a');
    const orgB = await createOrg('b');
    A1 = await seedWorkspace(orgA, 'a1');
    A2 = await seedWorkspace(orgA, 'a2');
    B1 = await seedWorkspace(orgB, 'b1');
  });

  afterAll(async () => {
    if (!RUN) return;
    await asAdmin(async (c) => {
      for (const org of orgs) await c.query('DELETE FROM core.organisation WHERE id = $1', [org]).catch(() => undefined);
    });
  });

  // ------------------------------------------------------------------------------------------------------------ MD-1
  it('MD-1 the runtime login is crewflow_owner without BYPASSRLS (the identity every check below runs as)', async () => {
    const row = await asOwner(async (c) => (await c.query(`SELECT current_user::text AS u, (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypass`)).rows[0]);
    expect(row).toEqual({ u: 'crewflow_owner', bypass: false });
  });

  it('MD-1 every table: ENABLE + FORCE, one tenant policy (USING = WITH CHECK), owner crewflow, crewflow_app S/I/U/D, nothing for PUBLIC', async () => {
    const rows = await asAdmin(
      async (c) =>
        (
          await c.query(
            `SELECT c.relname::text AS t, c.relrowsecurity AS rls, c.relforcerowsecurity AS force, pg_get_userbyid(c.relowner)::text AS owner,
                    (SELECT string_agg(p.polname || ':' || p.polcmd::text || ':' || p.polpermissive::text || ':' || p.polroles::text, ';' ORDER BY p.polname) FROM pg_policy p WHERE p.polrelid = c.oid) AS policies,
                    (SELECT bool_and(pg_get_expr(p.polqual, p.polrelid) = pg_get_expr(p.polwithcheck, p.polrelid)) FROM pg_policy p WHERE p.polrelid = c.oid) AS same_check,
                    (SELECT string_agg(DISTINCT pg_get_expr(p.polqual, p.polrelid), ';') FROM pg_policy p WHERE p.polrelid = c.oid) AS qual,
                    concat_ws(',', CASE WHEN has_table_privilege('crewflow_app', c.oid, 'SELECT') THEN 'S' END, CASE WHEN has_table_privilege('crewflow_app', c.oid, 'INSERT') THEN 'I' END,
                              CASE WHEN has_table_privilege('crewflow_app', c.oid, 'UPDATE') THEN 'U' END, CASE WHEN has_table_privilege('crewflow_app', c.oid, 'DELETE') THEN 'D' END,
                              CASE WHEN has_table_privilege('crewflow_app', c.oid, 'TRUNCATE') THEN 'T' END) AS app,
                    EXISTS (SELECT 1 FROM aclexplode(c.relacl) a WHERE a.grantee = 0) AS public_grant,
                    (SELECT count(*)::int FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname IN ('organisation_id', 'workspace_id') AND a.attnotnull) AS tenant_cols
               FROM pg_class c WHERE c.relnamespace = 'core'::regnamespace AND c.relname = ANY($1) ORDER BY 1`,
            [[...METADATA_TABLES]],
          )
        ).rows,
    );
    expect(rows.map((r) => r.t)).toEqual([...METADATA_TABLES].sort());
    for (const r of rows) {
      expect(r).toEqual({
        t: r.t,
        rls: true,
        force: true,
        owner: 'crewflow',
        policies: `${r.t}_tenant:*:true:{0}`,
        same_check: true,
        qual: '((organisation_id = core.current_org()) AND (workspace_id = core.current_workspace()))',
        app: 'S,I,U,D',
        public_grant: false,
        tenant_cols: 2,
      });
    }
    expect(TENANT_PREDICATE).toBe('organisation_id = core.current_org() AND workspace_id = core.current_workspace()');
  });

  it('MD-1 the guard triggers are present and enabled (a row guard and a TRUNCATE guard on all five)', async () => {
    const triggers = await asAdmin(
      async (c) =>
        (
          await c.query<{ line: string }>(
            `SELECT c.relname || ':' || t.tgname || ':' || t.tgenabled::text || ':' || t.tgfoid::regprocedure::text AS line
               FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
              WHERE c.relnamespace = 'core'::regnamespace AND NOT t.tgisinternal AND t.tgfoid = 'core.metadata_guard()'::regprocedure ORDER BY 1`,
          )
        ).rows.map((r) => r.line),
    );
    expect(triggers).toEqual(
      [
        ...METADATA_TABLES.map((t) => `${t}:${t}_truncate_guard:O:core.metadata_guard()`),
        ...METADATA_TABLES.map((t) => `${t}:${t}_guard:O:core.metadata_guard()`),
      ].sort(),
    );
  });

  // ------------------------------------------------------------------------------------------------------------ MD-2
  it('MD-2 no tenant context bound ⇒ zero rows from every metadata table, although rows exist (fail closed)', async () => {
    for (const t of METADATA_TABLES) {
      const total = await asAdmin(async (c) => (await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM core.${t}`)).rows[0]!.n);
      expect({ t, nonZero: total > 0 }).toEqual({ t, nonZero: true });
      const n = await asOwner(async (c) => (await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM core.${t}`)).rows[0]!.n);
      expect({ t, n }).toEqual({ t, n: 0 });
    }
  });

  // ----------------------------------------------------------------------------------------------------------- MT-07
  it('MT-07: a workspace sees exactly its own metadata rows; same API names elsewhere stay invisible', async () => {
    const expected = await countsOf(A1.workspace);
    await bound(A1, async (c) => {
      for (const t of METADATA_TABLES) {
        const r = (await c.query<{ n: number; foreign: number }>(`SELECT count(*)::int AS n, count(*) FILTER (WHERE workspace_id <> $1 OR organisation_id <> $2)::int AS foreign FROM core.${t}`, [A1.workspace, A1.org])).rows[0]!;
        expect({ t, ...r }).toEqual({ t, n: expected[t], foreign: 0 });
      }
      const equipments = (await c.query<{ id: string }>(`SELECT id::text FROM core.object_metadata WHERE name_plural = 'equipments'`)).rows.map((r) => r.id);
      expect(equipments).toEqual([A1.equipment]);
      for (const other of [A2, B1]) {
        expect((await c.query('SELECT 1 FROM core.object_metadata WHERE id = $1', [other.equipment])).rowCount).toBe(0);
        expect((await c.query('SELECT 1 FROM core.field_metadata WHERE object_metadata_id = $1', [other.staff])).rowCount).toBe(0);
      }
    });
  });

  it('MT-07: a mismatched binding (organisation B with workspace A1, or A with B1) sees nothing', async () => {
    for (const ws of [
      { org: B1.org, workspace: A1.workspace, user: B1.user },
      { org: A1.org, workspace: B1.workspace, user: A1.user },
    ]) {
      await bound(ws, async (c) => {
        for (const t of METADATA_TABLES) expect({ t, n: (await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM core.${t}`)).rows[0]!.n }).toEqual({ t, n: 0 });
      });
    }
  });

  it('MT-07: WITH CHECK refuses a row for another workspace or organisation (42501), and an UPDATE cannot move a row', async () => {
    await bound(A1, async (c) => {
      for (const target of [A2, B1]) {
        const [sql, params] = objectInsert({ organisation_id: target.org, workspace_id: target.workspace, name_singular: 'smuggled', name_plural: 'smuggleds', label_singular: 'S', label_plural: 'S', physical_table: `c_${randomBytes(4).toString('hex')}`, is_custom: true, allows_custom_fields: true });
        expect((await attempt(c, sql, params)).code).toBe('42501');
      }
      expect((await attempt(c, 'UPDATE core.field_metadata_option SET workspace_id = $1 WHERE workspace_id = $2', [A2.workspace, A1.workspace])).code).toBe('42501');
      // A foreign row is invisible to UPDATE / DELETE: nothing happens.
      expect(await attempt(c, `UPDATE core.object_metadata SET label_plural = 'pwned' WHERE id = $1`, [A2.equipment])).toEqual({ code: null, constraint: null, rowCount: 0 });
      expect(await attempt(c, 'DELETE FROM core.field_metadata WHERE id = $1', [B1.equipmentName])).toEqual({ code: null, constraint: null, rowCount: 0 });
    });
    const label = await asAdmin(async (c) => (await c.query<{ l: string }>('SELECT label_plural AS l FROM core.object_metadata WHERE id = $1', [A2.equipment])).rows[0]!.l);
    expect(label).toBe('Equipment');
  });

  // ------------------------------------------------------------------------------------------------------------ MD-3
  it('MD-3 composite foreign keys: no reference may cross a workspace or point at another object (23503), even for the superuser', async () => {
    await asAdmin((c) =>
      rolledBack(c, async () => {
        const t = { organisation_id: A1.org, workspace_id: A1.workspace };
        // a field of A1 on an object of A2
        const [f1, p1] = fieldInsert({ ...t, object_metadata_id: A2.equipment, type: 'TEXT', name: 'crossWs', label: 'x', physical_column: 'cf_crossws', is_custom: true });
        expect((await attempt(c, f1, p1)).code).toBe('23503');
        // a relation of A1 targeting an object of B1
        const [f2, p2] = fieldInsert({ ...t, object_metadata_id: A1.equipment, type: 'RELATION', name: 'crossRel', label: 'x', physical_column: 'cf_crossrel', is_custom: true, relation_target_object_metadata_id: B1.staff, settings: { relationType: 'MANY_TO_ONE' } });
        await c.query('SAVEPOINT deferred');
        await c.query(f2, p2);
        expect((await attempt(c, 'SET CONSTRAINTS ALL IMMEDIATE')).code).toBe('23503');
        await c.query('ROLLBACK TO SAVEPOINT deferred');
        // an option of A1 on a field of A2
        expect((await attempt(c, 'INSERT INTO core.field_metadata_option (organisation_id, workspace_id, field_metadata_id, value, label) VALUES ($1, $2, $3, $4, $5)', [A1.org, A1.workspace, A2.staffStatus, 'x', 'x'])).code).toBe('23503');
        // a label identifier that is a field of ANOTHER object of the same workspace
        await c.query('SAVEPOINT deferred');
        await c.query('UPDATE core.object_metadata SET label_identifier_field_id = $1 WHERE id = $2', [A1.staffRef, A1.equipment]);
        expect((await attempt(c, 'SET CONSTRAINTS ALL IMMEDIATE')).code).toBe('23503');
        await c.query('ROLLBACK TO SAVEPOINT deferred');
        // an index field that belongs to another object
        expect(
          (await attempt(c, 'INSERT INTO core.index_field_metadata (organisation_id, workspace_id, index_metadata_id, object_metadata_id, field_metadata_id, position) VALUES ($1, $2, $3, $4, $5, 1)', [A1.org, A1.workspace, A1.equipmentIndex, A1.equipment, A1.staffRef])).code,
        ).toBe('23503');
        // a workspace of another organisation
        const [o3, p3] = objectInsert({ organisation_id: B1.org, workspace_id: A1.workspace, name_singular: 'mixed', name_plural: 'mixeds', label_singular: 'M', label_plural: 'M', physical_table: 'c_mixed', is_custom: true, allows_custom_fields: true });
        expect((await attempt(c, o3, p3)).code).toBe('23503');
      }),
    );
  });

  // ----------------------------------------------------------------------------------------------------------- MT-26
  it('MT-26: what the engine trusts never changes (42501): physical names, type, kind flags, API names (OB-10), locks', async () => {
    const refused: Array<[string, unknown[]]> = [
      ['UPDATE core.object_metadata SET physical_table = $2 WHERE id = $1', [A1.staff, 'payroll_record']],
      ['UPDATE core.object_metadata SET name_plural = $2 WHERE id = $1', [A1.equipment, 'gadgets']],
      ['UPDATE core.object_metadata SET name_singular = $2 WHERE id = $1', [A1.equipment, 'gadget']],
      ['UPDATE core.object_metadata SET is_system = false WHERE id = $1', [A1.payroll]],
      ['UPDATE core.object_metadata SET storage = $2 WHERE id = $1', [A1.member, 'workspace']],
      ['UPDATE core.object_metadata SET universal_identifier = $2 WHERE id = $1', [A1.staff, randomUUID()]],
      ['UPDATE core.field_metadata SET physical_column = $2 WHERE id = $1', [A1.staffRef, 'default_pay_rate_pence']],
      ['UPDATE core.field_metadata SET type = $2 WHERE id = $1', [A1.equipmentSerial, 'NUMBER']],
      ['UPDATE core.field_metadata SET name = $2 WHERE id = $1', [A1.equipmentSerial, 'serial']],
      ['UPDATE core.field_metadata SET is_locked = false WHERE id = $1', [A1.staffPay]],
      ['UPDATE core.field_metadata SET is_active = false WHERE id = $1', [A1.staffRef]],
      ['UPDATE core.field_metadata SET is_money = false, is_sensitive = false WHERE id = $1', [A1.staffPay]],
      ['UPDATE core.field_metadata SET is_custom = true WHERE id = $1', [A1.staffRef]],
      ['UPDATE core.field_metadata SET object_metadata_id = $2 WHERE id = $1', [A1.equipmentSerial, A1.staff]],
      ['UPDATE core.field_metadata SET relation_target_object_metadata_id = $2 WHERE id = $1', [A1.staffUser, A1.payroll]],
    ];
    for (const as of [bound, boundAsCrewflow]) {
      await as(A1, async (c) => {
        for (const [sql, params] of refused) expect({ sql, code: (await attempt(c, sql, params)).code }).toEqual({ sql, code: '42501' });
      });
    }
  });

  it('MT-26: the request path may change only display columns of built-in / locked rows; custom rows stay editable', async () => {
    const allowed: Array<[string, unknown[]]> = [
      [`UPDATE core.object_metadata SET label_singular = 'Team member', description = 'x', icon = 'IconUser', nav_position = 2, updated_at = now() WHERE id = $1`, [A1.staff]],
      ['UPDATE core.object_metadata SET nav_position = 7 WHERE id = $1', [A1.payroll]],
      ['UPDATE core.object_metadata SET is_active = false, is_searchable = true WHERE id = $1', [A1.equipment]],
      [`UPDATE core.field_metadata SET label = 'Reference', description = 'd', icon = 'IconHash', position = 3 WHERE id = $1`, [A1.staffRef]],
      ['UPDATE core.field_metadata SET position = 9 WHERE id = $1', [A1.payrollId]],
      [`UPDATE core.field_metadata SET is_active = false, settings = '{"x": 1}', is_sensitive = true WHERE id = $1`, [A1.equipmentSerial]],
    ];
    await bound(A1, async (c) => {
      for (const [sql, params] of allowed) expect({ sql, r: await attempt(c, sql, params) }).toEqual({ sql, r: { code: null, constraint: null, rowCount: 1 } });
    });
  });

  it('review #165 M2: the request path cannot loosen built-in / locked metadata (42501); the sync identity (SET LOCAL ROLE crewflow) can', async () => {
    const fresh = () => v8();
    const t = { organisation_id: A1.org, workspace_id: A1.workspace };
    const ops: Array<[string, () => [string, unknown[]]]> = [
      ['locked field is_sensitive', () => ['UPDATE core.field_metadata SET is_sensitive = true WHERE id = $1', [A1.staffRef]]],
      ['locked field is_ui_read_only off', () => ['UPDATE core.field_metadata SET is_ui_read_only = false WHERE id = $1', [A1.staffStatus]]],
      ['locked field is_exportable_when_sensitive', () => ['UPDATE core.field_metadata SET is_exportable_when_sensitive = true WHERE id = $1', [A1.staffPay]]],
      ['locked field is_nullable', () => ['UPDATE core.field_metadata SET is_nullable = false WHERE id = $1', [A1.staffRef]]],
      ['locked field is_unique', () => ['UPDATE core.field_metadata SET is_unique = true WHERE id = $1', [A1.staffRef]]],
      ['locked relation onDelete', () => [`UPDATE core.field_metadata SET settings = '{"relationType": "MANY_TO_ONE", "onDelete": "SET_NULL"}' WHERE id = $1`, [A1.staffUser]]],
      ['locked relation inverse field', () => ['UPDATE core.field_metadata SET relation_target_field_metadata_id = $2 WHERE id = $1', [A1.staffUser, A1.memberId]]],
      ['label of a field of a system object', () => [`UPDATE core.field_metadata SET label = 'Pay id' WHERE id = $1`, [A1.payrollId]]],
      ['standard object allows_custom_fields', () => ['UPDATE core.object_metadata SET allows_custom_fields = false WHERE id = $1', [A1.staff]]],
      ['standard object is_searchable', () => ['UPDATE core.object_metadata SET is_searchable = true WHERE id = $1', [A1.staff]]],
      ['system object label', () => [`UPDATE core.object_metadata SET label_plural = 'Pay' WHERE id = $1`, [A1.payroll]]],
      ['lock a custom field', () => ['UPDATE core.field_metadata SET is_locked = true WHERE id = $1', [A1.equipmentSerial]]],
      ['option INSERT on a locked SELECT', () => ['INSERT INTO core.field_metadata_option (organisation_id, workspace_id, field_metadata_id, value, label) VALUES ($1, $2, $3, $4, $5)', [A1.org, A1.workspace, A1.staffStatus, 'smuggled', 'Smuggled']]],
      ['option UPDATE on a locked SELECT', () => [`UPDATE core.field_metadata_option SET label = 'Active!' WHERE field_metadata_id = $1 AND value = 'active'`, [A1.staffStatus]]],
      ['option DELETE on a locked SELECT', () => [`DELETE FROM core.field_metadata_option WHERE field_metadata_id = $1 AND value = 'pending_compliance'`, [A1.staffStatus]]],
      ['standard object INSERT', () => objectInsert({ ...t, universal_identifier: fresh(), name_singular: 'shiftReport', name_plural: 'shiftReports', label_singular: 'Report', label_plural: 'Reports', physical_table: 'shift_report', is_custom: false })],
      ['built-in field INSERT', () => fieldInsert({ ...t, object_metadata_id: A1.staff, universal_identifier: fresh(), type: 'TEXT', name: 'notes', label: 'Notes', physical_column: 'notes', is_custom: false, is_locked: true })],
      ['custom field born locked', () => fieldInsert({ ...t, object_metadata_id: A1.equipment, type: 'TEXT', name: 'tag', label: 'Tag', physical_column: 'cf_tag1', is_custom: true, is_locked: true })],
      ['index on a locked field', () => ['INSERT INTO core.index_field_metadata (organisation_id, workspace_id, index_metadata_id, object_metadata_id, field_metadata_id, position) VALUES ($1, $2, $3, $4, $5, 1)', [A1.org, A1.workspace, A1.equipmentIndex, A1.equipment, A1.equipmentId]]],
    ];
    await bound(A1, async (c) => {
      for (const [what, op] of ops) {
        const [sql, params] = op();
        expect({ what, code: (await attempt(c, sql, params)).code }).toEqual({ what, code: '42501' });
      }
    });
    await boundAsCrewflow(A1, async (c) => {
      expect((await c.query<{ u: string; s: string }>('SELECT current_user::text AS u, session_user::text AS s')).rows[0]).toEqual({ u: 'crewflow', s: 'crewflow_owner' });
      for (const [what, op] of ops) {
        const [sql, params] = op();
        const r = await attempt(c, sql, params);
        expect({ what, code: r.code, rows: r.rowCount }).toEqual({ what, code: null, rows: 1 });
      }
    });
  });

  it('review #165: index definitions never change; index fields are immutable for every identity (42501)', async () => {
    for (const as of [bound, boundAsCrewflow]) {
      await as(A1, async (c) => {
        for (const [sql, params] of [
          ['UPDATE core.index_metadata SET physical_name = $2 WHERE id = $1', [A1.equipmentIndex, 'ix_other1']],
          ['UPDATE core.index_metadata SET is_unique = false WHERE id = $1', [A1.equipmentIndex]],
          ['UPDATE core.index_field_metadata SET position = 2 WHERE index_metadata_id = $1', [A1.equipmentIndex]],
          [`UPDATE core.field_metadata_option SET value = 'ACTIVE' WHERE field_metadata_id = $1 AND value = 'active'`, [A1.staffStatus]],
        ] as Array<[string, unknown[]]>) {
          expect({ sql, code: (await attempt(c, sql, params)).code }).toEqual({ sql, code: '42501' });
        }
        // equipmentIndex covers only a custom, unlocked field: either identity may deactivate it.
        expect((await attempt(c, 'UPDATE core.index_metadata SET is_active = false WHERE id = $1', [A1.equipmentIndex])).code).toBeNull();
      });
    }
  });

  it('review #165 N1 / N2: indexes over built-in or locked fields, indexes on built-in objects and system fields belong to the sync identity', async () => {
    await bound(A1, async (c) => {
      // Narrow privileged section, as the E2 sync must do it: SET LOCAL ROLE crewflow, write, RESET ROLE.
      await c.query('SET LOCAL ROLE crewflow');
      const lockedIx = randomUUID();
      await c.query("INSERT INTO core.index_metadata (id, organisation_id, workspace_id, object_metadata_id, physical_name) VALUES ($1, $2, $3, $4, 'ix_lockedid1')", [lockedIx, A1.org, A1.workspace, A1.equipment]);
      await c.query('INSERT INTO core.index_field_metadata (organisation_id, workspace_id, index_metadata_id, object_metadata_id, field_metadata_id, position) VALUES ($1, $2, $3, $4, $5, 0)', [A1.org, A1.workspace, lockedIx, A1.equipment, A1.equipmentId]);
      await c.query('RESET ROLE');
      expect((await c.query<{ u: string }>('SELECT current_user::text AS u')).rows[0]!.u).toBe('crewflow_owner');
      const t = { organisation_id: A1.org, workspace_id: A1.workspace };
      const [sysField, sysParams] = fieldInsert({ ...t, object_metadata_id: A1.equipment, type: 'TEXT', name: 'sysLike', label: 'Sys', physical_column: 'cf_sys1', is_custom: true, is_system: true });
      const refused: Array<[string, string, unknown[]]> = [
        ['deactivate an index on a locked field', 'UPDATE core.index_metadata SET is_active = false WHERE id = $1', [lockedIx]],
        ['delete an index on a locked field', 'DELETE FROM core.index_metadata WHERE id = $1', [lockedIx]],
        ['index on a built-in object', "INSERT INTO core.index_metadata (organisation_id, workspace_id, object_metadata_id, physical_name) VALUES ($1, $2, $3, 'ix_staff1')", [A1.org, A1.workspace, A1.staff]],
        ['field INSERT with is_system', sysField, sysParams],
      ];
      for (const [what, sql, params] of refused) expect({ what, code: (await attempt(c, sql, params)).code }).toEqual({ what, code: '42501' });
      // a custom-only index is still the request path's to deactivate and delete
      expect(await attempt(c, 'UPDATE core.index_metadata SET is_active = false WHERE id = $1', [A1.equipmentIndex])).toEqual({ code: null, constraint: null, rowCount: 1 });
      expect(await attempt(c, 'DELETE FROM core.index_metadata WHERE id = $1', [A1.equipmentIndex])).toEqual({ code: null, constraint: null, rowCount: 1 });
      // the sync identity may do all of it
      await c.query('SET LOCAL ROLE crewflow');
      for (const [what, sql, params] of [refused[0]!, refused[2]!, refused[3]!, refused[1]!]) {
        const r = await attempt(c, sql, params);
        expect({ what, code: r.code, rows: r.rowCount }).toEqual({ what, code: null, rows: 1 });
      }
    });
  });

  it('review #165 L1: the guard fails closed when the parent row is missing or in another workspace (23503)', async () => {
    await boundAsCrewflow(A1, async (c) => {
      const t = { organisation_id: A1.org, workspace_id: A1.workspace };
      const [f1, p1] = fieldInsert({ ...t, object_metadata_id: randomUUID(), type: 'TEXT', name: 'orphan', label: 'Orphan', physical_column: 'cf_orphan1', is_custom: true });
      expect(await attempt(c, f1, p1)).toMatchObject({ code: '23503', constraint: 'field_metadata_object_fkey' });
      const opt = await attempt(c, 'INSERT INTO core.field_metadata_option (organisation_id, workspace_id, field_metadata_id, value, label) VALUES ($1, $2, $3, $4, $5)', [A1.org, A1.workspace, A2.staffStatus, 'x', 'x']);
      expect(opt).toMatchObject({ code: '23503', constraint: 'field_metadata_option_field_fkey' });
      const ixf = await attempt(c, 'INSERT INTO core.index_field_metadata (organisation_id, workspace_id, index_metadata_id, object_metadata_id, field_metadata_id, position) VALUES ($1, $2, $3, $4, $5, 2)', [A1.org, A1.workspace, A1.equipmentIndex, A1.equipment, A1.staffRef]);
      expect(ixf).toMatchObject({ code: '23503', constraint: 'index_field_metadata_field_fkey' });
    });
  });

  it('review #165 L2: a custom-field INSERT holds its object FOR SHARE, so allows_custom_fields cannot flip under it (55P03)', async () => {
    await asOwner(async (writer) => {
      await writer.query('BEGIN');
      try {
        await writer.query(BIND_SQL, [A1.org, A1.workspace, A1.user]);
        const [sql, params] = fieldInsert({ organisation_id: A1.org, workspace_id: A1.workspace, object_metadata_id: A1.staff, type: 'TEXT', name: 'racer', label: 'Racer', physical_column: 'cf_racer1', is_custom: true });
        await writer.query(sql, params);
        await boundAsCrewflow(A1, async (sync) => {
          await sync.query("SET LOCAL lock_timeout = '1s'");
          expect((await attempt(sync, 'UPDATE core.object_metadata SET allows_custom_fields = false WHERE id = $1', [A1.staff])).code).toBe('55P03');
        });
      } finally {
        await writer.query('ROLLBACK');
      }
    });
  });

  it('review #165 M1: the seven payroll / attendance tables are pinned to system objects without custom fields (23514)', async () => {
    await boundAsCrewflow(A1, async (c) => {
      const t = { organisation_id: A1.org, workspace_id: A1.workspace };
      for (const table of ['attendance', 'attendance_correction', 'payroll_record', 'payroll_run', 'payroll_run_line', 'payslip', 'payslip_document']) {
        const [sql, params] = objectInsert({ ...t, universal_identifier: v8(), name_singular: 'notPayroll', name_plural: 'notPayrolls', label_singular: 'X', label_plural: 'X', physical_table: table, is_custom: false, is_system: false });
        expect(await attempt(c, sql, params)).toMatchObject({ code: '23514', constraint: 'object_metadata_payroll_locked_ck' });
      }
      const r = await attempt(c, 'UPDATE core.object_metadata SET allows_custom_fields = true WHERE id = $1', [A1.payroll]);
      expect(r.code).toBe('23514');
    });
  });

  it('review #165 I1 / I3: core references only for the four known core tables; no bidi / zero-width characters in labels (23514)', async () => {
    await boundAsCrewflow(A1, async (c) => {
      const t = { organisation_id: A1.org, workspace_id: A1.workspace };
      const [o1, p1] = objectInsert({ ...t, storage: 'core_reference', universal_identifier: v8(), name_singular: 'org', name_plural: 'orgs', label_singular: 'Org', label_plural: 'Orgs', physical_table: 'organisation', is_custom: false, is_system: true });
      expect(await attempt(c, o1, p1)).toMatchObject({ code: '23514', constraint: 'object_metadata_core_reference_tables_ck' });
      for (const bad of ['Pay\u202Erate', 'Pay\u200Brate', '\uFEFFPay', 'Pay\u2066rate']) {
        const label = JSON.parse(`"${bad}"`) as string;
        const [o2, p2] = objectInsert({ ...t, name_singular: 'sneaky', name_plural: 'sneakies', label_singular: label, label_plural: 'Ok', physical_table: 'c_bidi1', is_custom: true, allows_custom_fields: true });
        expect({ bad, code: (await attempt(c, o2, p2)).code }).toEqual({ bad, code: '23514' });
        const [f2, pf2] = fieldInsert({ ...t, object_metadata_id: A1.equipment, type: 'TEXT', name: 'sneaky', label, physical_column: 'cf_bidi1', is_custom: true });
        expect({ bad, field: (await attempt(c, f2, pf2)).code }).toEqual({ bad, field: '23514' });
      }
      const [ok, pok] = objectInsert({ ...t, name_singular: 'accented', name_plural: 'accenteds', label_singular: 'Équipe café', label_plural: 'Équipes', physical_table: 'c_acc1', is_custom: true, allows_custom_fields: true });
      expect((await attempt(c, ok, pok)).code).toBeNull();
    });
  });

  it('MT-26: standard / system objects and locked / system fields are never deleted directly; custom rows are; the custom-object cascade works', async () => {
    await bound(A1, async (c) => {
      for (const [sql, id] of [
        ['DELETE FROM core.object_metadata WHERE id = $1', A1.staff],
        ['DELETE FROM core.object_metadata WHERE id = $1', A1.payroll],
        ['DELETE FROM core.object_metadata WHERE id = $1', A1.member],
        ['DELETE FROM core.field_metadata WHERE id = $1', A1.staffRef],
        ['DELETE FROM core.field_metadata WHERE id = $1', A1.equipmentId],
      ] as const) {
        expect({ sql, id, code: (await attempt(c, sql, [id])).code }).toEqual({ sql, id, code: '42501' });
      }
      // a custom field still used by an index: the index metadata goes first (NO ACTION)
      expect((await attempt(c, 'DELETE FROM core.field_metadata WHERE id = $1', [A1.equipmentSerial])).code).toBe('23503');
      // the custom object: cascades its fields (including the locked system `id` field), its index and index fields
      expect(await attempt(c, 'DELETE FROM core.object_metadata WHERE id = $1', [A1.equipment])).toEqual({ code: null, constraint: null, rowCount: 1 });
      await c.query('SET CONSTRAINTS ALL IMMEDIATE');
      const left = (await c.query<{ f: number; i: number; x: number }>(
        `SELECT (SELECT count(*) FROM core.field_metadata WHERE object_metadata_id = $1)::int AS f,
                (SELECT count(*) FROM core.index_metadata WHERE object_metadata_id = $1)::int AS i,
                (SELECT count(*) FROM core.index_field_metadata WHERE object_metadata_id = $1)::int AS x`,
        [A1.equipment],
      )).rows[0];
      expect(left).toEqual({ f: 0, i: 0, x: 0 });
    });
  });

  // ------------------------------------------------------------------------------------------------------------ MD-4
  it('MD-4 §0.3 / §0.5 at INSERT: custom fields only where allowed, CURRENCY on custom objects only (23514, named constraint)', async () => {
    await bound(A1, async (c) => {
      const t = { organisation_id: A1.org, workspace_id: A1.workspace, is_custom: true };
      const cases: Array<[string, FieldRow, string | null]> = [
        ['custom field on a system object', { object_metadata_id: A1.payroll, type: 'TEXT', name: 'note', physical_column: 'cf_note1' }, 'field_metadata_custom_fields_allowed'],
        ['custom field on a core reference object', { object_metadata_id: A1.member, type: 'TEXT', name: 'note', physical_column: 'cf_note2' }, 'field_metadata_custom_fields_allowed'],
        ['CURRENCY on a standard object', { object_metadata_id: A1.staff, type: 'CURRENCY', name: 'bonus', physical_column: 'cf_bonus1' }, 'field_metadata_currency_custom_object_only'],
        ['CURRENCY on a custom object', { object_metadata_id: A1.equipment, type: 'CURRENCY', name: 'price', physical_column: 'cf_price1' }, null],
        ['custom TEXT on a standard object that allows custom fields', { object_metadata_id: A1.staff, type: 'TEXT', name: 'shoeSize', physical_column: 'cf_shoe1' }, null],
      ];
      for (const [what, row, constraint] of cases) {
        const [sql, params] = fieldInsert({ ...t, label: what.slice(0, 40), ...row });
        const r = await attempt(c, sql, params);
        expect({ what, code: r.code, constraint: r.constraint }).toEqual({ what, code: constraint ? '23514' : null, constraint });
      }
    });
  });

  it('MD-4 type and shape rules (as the sync identity): MORPH_RELATION, custom RANGE, custom money, bad identifiers and core-reference shape refused (23514)', async () => {
    await boundAsCrewflow(A1, async (c) => {
      const t = { organisation_id: A1.org, workspace_id: A1.workspace };
      const fieldCases: Array<[string, FieldRow, string | null]> = [
        ['MORPH_RELATION', { is_custom: true, object_metadata_id: A1.equipment, type: 'MORPH_RELATION', name: 'm', physical_column: 'cf_m1' }, '23514'],
        ['custom RANGE', { is_custom: true, object_metadata_id: A1.equipment, type: 'RANGE', name: 'r', physical_column: 'cf_r1' }, '23514'],
        ['built-in system RANGE', { is_custom: false, universal_identifier: v8(), is_locked: true, is_system: true, object_metadata_id: A1.staff, type: 'RANGE', name: 'period', physical_column: 'period' }, null],
        ['unknown type', { is_custom: true, object_metadata_id: A1.equipment, type: 'DROP TABLE', name: 'u', physical_column: 'cf_u1' }, '23514'],
        ['custom money', { is_custom: true, object_metadata_id: A1.equipment, type: 'NUMBER', name: 'pay', physical_column: 'cf_pay1', is_money: true, is_sensitive: true, is_ui_read_only: true }, '23514'],
        ['built-in field not locked', { is_custom: false, universal_identifier: v8(), object_metadata_id: A1.staff, type: 'TEXT', name: 'loose', physical_column: 'loose' }, '23514'],
        ['custom field with a built-in column name', { is_custom: true, object_metadata_id: A1.equipment, type: 'TEXT', name: 'sneaky', physical_column: 'amount_pence' }, '23514'],
        ['built-in field with a custom column name', { is_custom: false, universal_identifier: v8(), is_locked: true, object_metadata_id: A1.staff, type: 'TEXT', name: 'sneaky', physical_column: 'cf_sneaky' }, '23514'],
        ['name with SQL', { is_custom: true, object_metadata_id: A1.equipment, type: 'TEXT', name: 'a"; drop table x; --', physical_column: 'cf_sql1' }, '23514'],
        ['column with SQL', { is_custom: true, object_metadata_id: A1.equipment, type: 'TEXT', name: 'colSql', physical_column: 'cf_x"; drop' }, '23514'],
        ['name of 64 characters', { is_custom: true, object_metadata_id: A1.equipment, type: 'TEXT', name: `a${'b'.repeat(63)}`, physical_column: 'cf_long1' }, '23514'],
        ['relation without relationType', { is_custom: true, object_metadata_id: A1.equipment, type: 'RELATION', name: 'rel', physical_column: 'cf_rel1', relation_target_object_metadata_id: A1.staff }, '23514'],
        ['ONE_TO_MANY with a column', { is_custom: true, object_metadata_id: A1.equipment, type: 'RELATION', name: 'rel2', physical_column: 'cf_rel2', relation_target_object_metadata_id: A1.staff, settings: { relationType: 'ONE_TO_MANY' } }, '23514'],
        ['non-relation without a column', { is_custom: true, object_metadata_id: A1.equipment, type: 'TEXT', name: 'nocol', physical_column: null }, '23514'],
        ['custom field with a built-in (v8) universal identifier (#166 F4 / owner batch 11)', { is_custom: true, object_metadata_id: A1.staff, type: 'TEXT', name: 'squat', physical_column: 'cf_squat1', universal_identifier: v8() }, '23514'],
        ['custom field with its own generated (v4) universal identifier', { is_custom: true, object_metadata_id: A1.staff, type: 'TEXT', name: 'ownUid', physical_column: 'cf_ownuid1', universal_identifier: randomUUID() }, null],
      ];
      for (const [what, row, code] of fieldCases) {
        const [sql, params] = fieldInsert({ ...t, label: what.slice(0, 40), ...row });
        expect({ what, code: (await attempt(c, sql, params)).code }).toEqual({ what, code });
      }
      const objectCases: Array<[string, ObjectRow, string | null]> = [
        ['core reference that allows custom fields', { storage: 'core_reference', universal_identifier: v8(), is_custom: false, is_system: true, allows_custom_fields: true, physical_table: 'stored_file' }, '23514'],
        ['custom object with a built-in (v8) universal identifier', { is_custom: true, allows_custom_fields: true, universal_identifier: v8(), physical_table: 'c_uid1' }, '23514'],
        ['custom object on a built-in table name', { is_custom: true, allows_custom_fields: true, physical_table: 'payroll_record' }, '23514'],
        ['standard object on a c_ name', { is_custom: false, universal_identifier: v8(), physical_table: 'c_std1' }, '23514'],
        ['system object that allows custom fields', { is_custom: false, is_system: true, allows_custom_fields: true, universal_identifier: v8(), physical_table: 'payslip' }, '23514'],
        ['label with a control character', { is_custom: true, allows_custom_fields: true, physical_table: 'c_ctl1', label_singular: 'a\u0007b' }, '23514'],
        ['a valid custom object', { is_custom: true, allows_custom_fields: true, physical_table: 'c_ok1' }, null],
      ];
      let n = 0;
      for (const [what, row, code] of objectCases) {
        n += 1;
        const [sql, params] = objectInsert({ ...t, name_singular: `thing${n}`, name_plural: `things${n}`, label_singular: 'Thing', label_plural: 'Things', ...row });
        expect({ what, code: (await attempt(c, sql, params)).code }).toEqual({ what, code });
      }
      // name collisions are case-insensitive per workspace (Twenty unique names)
      const [dup, dupParams] = objectInsert({ ...t, name_singular: 'eQUIPMENT', name_plural: 'equipmentList', label_singular: 'E', label_plural: 'E', physical_table: 'c_dup1', is_custom: true, allows_custom_fields: true });
      expect((await attempt(c, dup, dupParams)).code).toBe('23505');
      // standard option values keep the stored lowercase value; quotes and spaces never pass
      for (const [value, code] of [['clockInAt', null], ['in progress', '23514'], ["x'y", '23514'], ['', '23514']] as const) {
        const r = await attempt(c, 'INSERT INTO core.field_metadata_option (organisation_id, workspace_id, field_metadata_id, value, label) VALUES ($1, $2, $3, $4, $5)', [A1.org, A1.workspace, A1.staffStatus, value, 'x']);
        expect({ value, code: r.code }).toEqual({ value, code });
      }
    });
  });

  // ------------------------------------------------------------------------------------------------------------ MD-5
  it('MD-5 TRUNCATE is refused to the request path on every metadata table, even through the owner membership (42501)', async () => {
    await asOwner(async (c) => {
      for (const t of METADATA_TABLES) {
        const r = await rolledBack(c, () => attempt(c, `TRUNCATE core.${t} CASCADE`));
        expect({ t, code: r.code }).toEqual({ t, code: '42501' });
      }
    });
    expect((await countsOf(B1.workspace)).object_metadata).toBe(4);
  });

  it('review #165: TRUNCATE core.manager_workspace CASCADE by the request path (rolled back) is refused, and no metadata row is lost', async () => {
    const before = await countsOf(B1.workspace);
    const r = await asOwner((c) =>
      rolledBack(c, async () => {
        expect((await c.query<{ u: string }>('SELECT current_user::text AS u')).rows[0]!.u).toBe('crewflow_owner');
        return attempt(c, 'TRUNCATE core.manager_workspace CASCADE');
      }),
    );
    expect(r.code).toBe('42501');
    expect(await countsOf(B1.workspace)).toEqual(before);
  });

  it('review #165: the superuser (test teardowns) may TRUNCATE CASCADE through the metadata tables (rolled back)', async () => {
    const before = await countsOf(B1.workspace);
    const r = await asAdmin((c) =>
      rolledBack(c, async () => {
        const out = await attempt(c, 'TRUNCATE core.manager_workspace CASCADE');
        const left = (await c.query<{ n: number }>('SELECT count(*)::int AS n FROM core.object_metadata')).rows[0]!.n;
        return { ...out, left };
      }),
    );
    expect(r).toMatchObject({ code: null, left: 0 });
    expect(await countsOf(B1.workspace)).toEqual(before);
  });

  // ------------------------------------------------------------------------------------------------------------ MD-7
  it('MD-7 MetadataReadService: the bound workspace only, nested and sorted; refused with no workspace bound', async () => {
    const ds = new DataSource({ type: 'postgres', url: OWNER_URL, entities: Object.values(metadataEntities), synchronize: false, logging: false, extra: { max: 1 } });
    await ds.initialize();
    try {
      const service = new MetadataReadService();
      const snapshot = await ds.transaction(async (m) => {
        await m.query(BIND_SQL, [A1.org, A1.workspace, A1.user]);
        return service.readWorkspaceMetadata(m);
      });
      expect(snapshot.organisationId).toBe(A1.org);
      expect(snapshot.workspaceId).toBe(A1.workspace);
      expect(snapshot.objects.map((o) => o.namePlural)).toEqual(['equipments', 'payrollRecords', 'staffProfiles', 'workspaceMembers']);
      const all = snapshot.objects.flatMap((o) => [o.workspaceId, ...o.fields.map((f) => f.workspaceId)]);
      expect(new Set(all)).toEqual(new Set([A1.workspace]));
      const staff = snapshot.objects.find((o) => o.id === A1.staff)!;
      expect(staff.fields.find((f) => f.id === A1.staffStatus)!.options.map((o) => o.value)).toEqual(['active', 'pending_compliance']);
      expect(staff.fields.find((f) => f.id === A1.staffPay)).toMatchObject({ isMoney: true, isLocked: true, isSensitive: true, isUiReadOnly: true, type: 'NUMBER' });
      const equipment = snapshot.objects.find((o) => o.id === A1.equipment)!;
      expect(equipment.indexes.map((i) => i.fields.map((f) => f.fieldMetadataId))).toEqual([[A1.equipmentSerial]]);

      const byName = await ds.transaction(async (m) => {
        await m.query(BIND_SQL, [A1.org, A1.workspace, A1.user]);
        return [await service.findObjectByNamePlural(m, 'EQUIPMENTS'), await service.findObjectById(m, A2.equipment)];
      });
      expect(byName[0]?.id).toBe(A1.equipment);
      expect(byName[1]).toBeNull();

      await expect(ds.transaction((m) => service.readWorkspaceMetadata(m))).rejects.toBeInstanceOf(MetadataContextError);
    } finally {
      await ds.destroy();
    }
  });

  // ------------------------------------------------------------------------------------------------------------ MD-8
  it('MD-8 the RLS coverage gate (tools/check-rls-coverage.ts) passes as crewflow_owner with the metadata tables present', () => {
    const r = spawnSync(process.execPath, [join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'), join(REPO_ROOT, 'tools', 'check-rls-coverage.ts')], {
      cwd: REPO_ROOT,
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', SystemRoot: process.env.SystemRoot ?? '', NODE_ENV: 'test', PG_DATABASE_URL: OWNER_URL },
      encoding: 'utf8',
      timeout: 240_000,
    });
    if (r.status !== 0) {
      const tail = `${r.stdout}\n${r.stderr}`.split('\n').filter((l) => !/:\/\//.test(l)).slice(-15).join('\n');
      throw new Error(`check-rls-coverage exited ${r.status}:\n${tail}`);
    }
    expect(r.stdout).toMatch(/RLS coverage OK/);
  });

  // ------------------------------------------------------------------------------------------------------------ MD-9
  it('MD-9 owner batch 11: every object / field row carries a universal identifier; custom rows get a generated v4, built-in rows keep the v8', async () => {
    const seeded = await asAdmin(
      async (c) =>
        (
          await c.query<{ id: string; uid: string | null; is_custom: boolean }>(
            `SELECT id::text, universal_identifier::text AS uid, is_custom FROM core.object_metadata WHERE workspace_id = $1
             UNION ALL SELECT id::text, universal_identifier::text, is_custom FROM core.field_metadata WHERE workspace_id = $1`,
            [A1.workspace],
          )
        ).rows,
    );
    expect(seeded.filter((r) => r.is_custom).length).toBeGreaterThanOrEqual(3); // equipment + its two custom fields (DEFAULT)
    for (const r of seeded) expect({ id: r.id, version: r.uid?.[14] }).toEqual({ id: r.id, version: r.is_custom ? '4' : '8' });
    // the same standard identifiers live in all three workspaces: unique per workspace, not globally
    const sharing = await asAdmin(async (c) => (await c.query<{ n: number }>('SELECT count(DISTINCT workspace_id)::int AS n FROM core.object_metadata WHERE universal_identifier = $1', [UID.staff])).rows[0]!.n);
    expect(sharing).toBeGreaterThanOrEqual(3);

    const t = { organisation_id: A1.org, workspace_id: A1.workspace };
    const custom = randomBytes(5).toString('hex');
    await bound(A1, async (c) => {
      // the request path: no identifier supplied → a generated version-4 one
      const [oSql, oParams] = objectInsert({ ...t, name_singular: 'uidThing', name_plural: 'uidThings', label_singular: 'U', label_plural: 'U', physical_table: `c_${custom}`, is_custom: true, allows_custom_fields: true });
      const obj = (await c.query<{ id: string; uid: string }>(`${oSql} RETURNING id::text, universal_identifier::text AS uid`, oParams)).rows[0]!;
      expect(obj.uid[14]).toBe('4');
      const [fSql, fParams] = fieldInsert({ ...t, object_metadata_id: obj.id, type: 'TEXT', name: 'tag', label: 'Tag', physical_column: `cf_${custom}t`, is_custom: true });
      const field = (await c.query<{ id: string; uid: string }>(`${fSql} RETURNING id::text, universal_identifier::text AS uid`, fParams)).rows[0]!;
      expect(field.uid[14]).toBe('4');
      // unique per workspace, an explicit NULL is refused, and the identifier never changes
      const [dupO, dupOp] = objectInsert({ ...t, universal_identifier: obj.uid, name_singular: 'uidTwin', name_plural: 'uidTwins', label_singular: 'U', label_plural: 'U', physical_table: `c_${custom}2`, is_custom: true, allows_custom_fields: true });
      expect(await attempt(c, dupO, dupOp)).toMatchObject({ code: '23505', constraint: 'object_metadata_universal_identifier_uq' });
      const [dupF, dupFp] = fieldInsert({ ...t, universal_identifier: field.uid, object_metadata_id: obj.id, type: 'TEXT', name: 'tagTwin', label: 'Tag', physical_column: `cf_${custom}u`, is_custom: true });
      expect(await attempt(c, dupF, dupFp)).toMatchObject({ code: '23505', constraint: 'field_metadata_universal_identifier_uq' });
      const [nulF, nulFp] = fieldInsert({ ...t, universal_identifier: null, object_metadata_id: obj.id, type: 'TEXT', name: 'tagNull', label: 'Tag', physical_column: `cf_${custom}n`, is_custom: true });
      expect((await attempt(c, nulF, nulFp)).code).toBe('23502');
      expect((await attempt(c, 'UPDATE core.field_metadata SET universal_identifier = $2 WHERE id = $1', [field.id, randomUUID()])).code).toBe('42501');
      expect((await attempt(c, 'UPDATE core.object_metadata SET universal_identifier = $2 WHERE id = $1', [obj.id, randomUUID()])).code).toBe('42501');
      // I-1: the squat cases on the request role itself: a custom row holding a built-in (v8) identifier is refused by the kind CHECK
      const [sqF, sqFp] = fieldInsert({ ...t, universal_identifier: v8(), object_metadata_id: A1.staff, type: 'TEXT', name: 'squatReq', label: 'Squat', physical_column: `cf_${custom}q`, is_custom: true });
      expect(await attempt(c, sqF, sqFp)).toMatchObject({ code: '23514', constraint: 'field_metadata_universal_identifier_kind_ck' });
      const [sqO, sqOp] = objectInsert({ ...t, universal_identifier: v8(), name_singular: 'squatThing', name_plural: 'squatThings', label_singular: 'S', label_plural: 'S', physical_table: `c_${custom}3`, is_custom: true, allows_custom_fields: true });
      expect(await attempt(c, sqO, sqOp)).toMatchObject({ code: '23514', constraint: 'object_metadata_universal_identifier_kind_ck' });
      // and taking the exact identifier of a standard field / object of this workspace fails the same way
      const [stF, stFp] = fieldInsert({ ...t, universal_identifier: UID.staffRef, object_metadata_id: A1.staff, type: 'TEXT', name: 'squatRef', label: 'Squat', physical_column: `cf_${custom}r`, is_custom: true });
      expect(await attempt(c, stF, stFp)).toMatchObject({ code: '23514', constraint: 'field_metadata_universal_identifier_kind_ck' });
      const [stO, stOp] = objectInsert({ ...t, universal_identifier: UID.payroll, name_singular: 'squatPay', name_plural: 'squatPays', label_singular: 'S', label_plural: 'S', physical_table: `c_${custom}4`, is_custom: true, allows_custom_fields: true });
      expect(await attempt(c, stO, stOp)).toMatchObject({ code: '23514', constraint: 'object_metadata_universal_identifier_kind_ck' });
    });
    await boundAsCrewflow(A1, async (c) => {
      // a built-in INSERT that forgets its identifier gets the v4 DEFAULT and is refused (fails closed, as before)
      const [o1, p1] = objectInsert({ ...t, name_singular: 'noUid', name_plural: 'noUids', label_singular: 'N', label_plural: 'N', physical_table: 'no_uid_table', is_custom: false });
      expect(await attempt(c, o1, p1)).toMatchObject({ code: '23514', constraint: 'object_metadata_universal_identifier_kind_ck' });
      const [f1, pf1] = fieldInsert({ ...t, universal_identifier: randomUUID(), object_metadata_id: A1.staff, type: 'TEXT', name: 'v4Builtin', label: 'X', physical_column: 'v4_builtin', is_custom: false, is_locked: true });
      expect(await attempt(c, f1, pf1)).toMatchObject({ code: '23514', constraint: 'field_metadata_universal_identifier_kind_ck' });
      const [f2, pf2] = fieldInsert({ ...t, universal_identifier: v8(), object_metadata_id: A1.staff, type: 'TEXT', name: 'v8Builtin', label: 'X', physical_column: 'v8_builtin', is_custom: false, is_locked: true });
      expect((await attempt(c, f2, pf2)).code).toBeNull();
      const [f3, pf3] = fieldInsert({ ...t, universal_identifier: UID.staffRef, object_metadata_id: A1.staff, type: 'TEXT', name: 'twinRef', label: 'X', physical_column: 'twin_ref', is_custom: false, is_locked: true });
      expect(await attempt(c, f3, pf3)).toMatchObject({ code: '23505', constraint: 'field_metadata_universal_identifier_uq' });
    });
  });

  // ----------------------------------------------------------------------------------------------------------- MD-10
  /**
   * Owner batch 11, condition 2. The binding is TenantContextService.runInTenantContext itself (RESET ROLE, the folded
   * set_config SELECT, search_path core, the current_user = session_user check), on a pooled DataSource of the runtime login,
   * exactly as every request reaches the database. crewflow_owner reaches the metadata tables through its membership of the
   * owner role crewflow (INHERIT, bootstrap.ts), never through crewflow_app (ADMIN only, no INHERIT / SET), so FORCE RLS, the
   * one tenant policy and the guard are the whole boundary. Request-path writes are undone by throwing ROLLBACK.
   */
  describe('MD-10 owner condition 2: as crewflow_owner on the request path (TenantContextService)', () => {
    let ds: DataSource;
    let tenant: TenantContextService;
    const ROLLBACK = new Error('md-10: roll back the request-path writes');
    const hwsOff = { get: (key: string) => (key === 'HWS_RUNTIME_ENABLED' ? false : undefined) } as unknown as EnvironmentService;
    const noResolver = { resolve: async () => Promise.reject(new Error('the schema resolver is never reached with HWS off')) } as unknown as SchemaResolverService;
    const ctxOf = (org: string | null, workspace: string | null, user: string): AuthContext => ({ organisationId: org, workspaceId: workspace, userId: user, role: '' });
    const pgError = (e: unknown) => {
      const x = e as { code?: string; constraint?: string; driverError?: { code?: string; constraint?: string } };
      return { code: x.driverError?.code ?? x.code ?? 'unknown', constraint: x.driverError?.constraint ?? x.constraint ?? null };
    };
    /** `sql` (a SELECT returning `n`) inside a savepoint of the request transaction. */
    async function tryOn(m: EntityManager, sql: string, params: unknown[] = []): Promise<{ code: string | null; constraint: string | null; n: number }> {
      await m.query('SAVEPOINT md_req');
      try {
        const rows = (await m.query(sql, params)) as Array<{ n: number }>;
        await m.query('RELEASE SAVEPOINT md_req');
        return { code: null, constraint: null, n: rows[0]!.n };
      } catch (e) {
        await m.query('ROLLBACK TO SAVEPOINT md_req');
        return { ...pgError(e), n: 0 };
      }
    }
    /** A data-modifying statement as a row count the request path can read (works the same for INSERT / UPDATE / DELETE). */
    const counted = (dml: string) => `WITH w AS (${dml} RETURNING 1) SELECT count(*)::int AS n FROM w`;
    /** Run fn on the request path and roll the transaction back (whatever fn wrote); returns fn's result. */
    async function requestRolledBack<T>(ctx: AuthContext, fn: (m: EntityManager) => Promise<T>): Promise<T> {
      let out: { value: T } | undefined;
      await expect(
        tenant.runInTenantContext(ctx, async (m) => {
          out = { value: await fn(m) };
          throw ROLLBACK;
        }),
      ).rejects.toBe(ROLLBACK);
      return out!.value;
    }
    const visible = async (m: EntityManager, ws: Pick<Ws, 'org' | 'workspace'>) => {
      const out: Record<string, { n: number; foreign: number }> = {};
      for (const t of METADATA_TABLES) {
        const r = ((await m.query(`SELECT count(*)::int AS n, count(*) FILTER (WHERE workspace_id <> $1 OR organisation_id <> $2)::int AS foreign FROM core.${t}`, [ws.workspace, ws.org])) as Array<{ n: number; foreign: number }>)[0]!;
        out[t] = r;
      }
      return out;
    };

    beforeAll(async () => {
      ds = new DataSource({ type: 'postgres', url: OWNER_URL, entities: [], synchronize: false, logging: false, extra: { max: 1, application_name: 'metadata-tables-spec-md10' } });
      await ds.initialize();
      tenant = new TenantContextService(ds, noResolver, hwsOff); // also installs the pool's RESET ROLE checkout hook
    });
    afterAll(async () => {
      await ds?.destroy();
    });

    it('MD-10 the request identity: crewflow_owner, session = current user, the tenant bound, the tables reached through crewflow (not crewflow_app)', async () => {
      const id = await tenant.runInTenantContext(ctxOf(A1.org, A1.workspace, A1.user), async (m) =>
        ((await m.query(
          `SELECT current_user::text AS cu, session_user::text AS su, core.current_org()::text AS org, core.current_workspace()::text AS ws,
                  pg_has_role(current_user, 'crewflow', 'USAGE') AS via_owner,
                  pg_has_role(current_user, 'crewflow_app', 'USAGE') AS via_app, (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypass`,
        )) as Array<Record<string, unknown>>)[0],
      );
      expect(id).toEqual({ cu: 'crewflow_owner', su: 'crewflow_owner', org: A1.org, ws: A1.workspace, via_owner: true, via_app: false, bypass: false });
    });

    it('MD-10 (1) reads and writes exactly the bound workspace’s metadata rows, on all five tables', async () => {
      const expected = await countsOf(A1.workspace);
      const custom = randomBytes(5).toString('hex');
      const t = { organisation_id: A1.org, workspace_id: A1.workspace };
      const out = await requestRolledBack(ctxOf(A1.org, A1.workspace, A1.user), async (m) => {
        const before = await visible(m, A1);
        const [oSql, oParams] = objectInsert({ ...t, name_singular: 'requestThing', name_plural: 'requestThings', label_singular: 'Thing', label_plural: 'Things', physical_table: `c_${custom}`, is_custom: true, allows_custom_fields: true });
        const obj = ((await m.query(`${oSql} RETURNING id::text, universal_identifier::text AS uid`, oParams)) as Array<{ id: string; uid: string }>)[0]!;
        const [fSql, fParams] = fieldInsert({ ...t, object_metadata_id: obj.id, type: 'SELECT', name: 'size', label: 'Size', physical_column: `cf_${custom}s`, is_custom: true });
        const field = ((await m.query(`${fSql} RETURNING id::text, universal_identifier::text AS uid`, fParams)) as Array<{ id: string; uid: string }>)[0]!;
        const writes = {
          option: await tryOn(m, counted('INSERT INTO core.field_metadata_option (organisation_id, workspace_id, field_metadata_id, value, label) VALUES ($1, $2, $3, $4, $5)'), [A1.org, A1.workspace, field.id, 'small', 'Small']),
          index: await tryOn(m, counted('INSERT INTO core.index_metadata (organisation_id, workspace_id, object_metadata_id, physical_name) VALUES ($1, $2, $3, $4)'), [A1.org, A1.workspace, obj.id, `ix_${custom}`]),
          indexField: await tryOn(
            m,
            counted(`INSERT INTO core.index_field_metadata (organisation_id, workspace_id, index_metadata_id, object_metadata_id, field_metadata_id, position)
                     SELECT $1, $2, i.id, i.object_metadata_id, $3, 0 FROM core.index_metadata i WHERE i.physical_name = $4`),
            [A1.org, A1.workspace, field.id, `ix_${custom}`],
          ),
          objectUpdate: await tryOn(m, counted(`UPDATE core.object_metadata SET label_plural = 'Request things' WHERE id = $1`), [obj.id]),
          fieldUpdate: await tryOn(m, counted(`UPDATE core.field_metadata SET label = 'Shoe size' WHERE id = $1`), [field.id]),
          optionUpdate: await tryOn(m, counted(`UPDATE core.field_metadata_option SET label = 'S' WHERE field_metadata_id = $1`), [field.id]),
          seededUpdate: await tryOn(m, counted(`UPDATE core.field_metadata SET label = 'Serial no.' WHERE id = $1`), [A1.equipmentSerial]),
        };
        const after = await visible(m, A1);
        const deletes = {
          option: await tryOn(m, counted('DELETE FROM core.field_metadata_option WHERE field_metadata_id = $1'), [field.id]),
          object: await tryOn(m, counted('DELETE FROM core.object_metadata WHERE id = $1'), [obj.id]), // cascades its field, index, index field
        };
        return { before, after, writes, deletes, uids: [obj.uid[14], field.uid[14]], end: await visible(m, A1) };
      });
      const one = { code: null, constraint: null, n: 1 };
      expect(out.writes).toEqual({ option: one, index: one, indexField: one, objectUpdate: one, fieldUpdate: one, optionUpdate: one, seededUpdate: one });
      expect(out.deletes).toEqual({ option: one, object: one });
      expect(out.uids).toEqual(['4', '4']);
      for (const tbl of METADATA_TABLES) {
        expect({ tbl, ...out.before[tbl] }).toEqual({ tbl, n: expected[tbl], foreign: 0 });
        expect({ tbl, ...out.after[tbl] }).toEqual({ tbl, n: expected[tbl]! + 1, foreign: 0 });
        expect({ tbl, ...out.end[tbl] }).toEqual({ tbl, n: expected[tbl], foreign: 0 });
      }
      expect(await countsOf(A1.workspace)).toEqual(expected); // rolled back
      const serial = await asAdmin(async (c) => (await c.query<{ l: string }>('SELECT label AS l FROM core.field_metadata WHERE id = $1', [A1.equipmentSerial])).rows[0]!.l);
      expect(serial).toBe('Serial number');
    });

    it('MD-10 (2) no binding: zero rows from every table and no write, on a bare pooled connection and through TenantContextService', async () => {
      for (const tbl of METADATA_TABLES) {
        const total = await asAdmin(async (c) => (await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM core.${tbl}`)).rows[0]!.n);
        expect({ tbl, nonZero: total > 0 }).toEqual({ tbl, nonZero: true });
        const bare = ((await ds.query(`SELECT count(*)::int AS n FROM core.${tbl}`)) as Array<{ n: number }>)[0]!.n;
        expect({ tbl, bare }).toEqual({ tbl, bare: 0 });
      }
      const zero = Object.fromEntries(METADATA_TABLES.map((tbl) => [tbl, { n: 0, foreign: 0 }]));
      // no organisation and no workspace; and an organisation with no workspace (a manager mid-onboarding)
      for (const ctx of [ctxOf(null, null, A1.user), ctxOf(A1.org, null, A1.user)]) {
        const r = await requestRolledBack(ctx, async (m) => {
          const [oSql, oParams] = objectInsert({ organisation_id: A1.org, workspace_id: A1.workspace, name_singular: 'unbound', name_plural: 'unbounds', label_singular: 'U', label_plural: 'U', physical_table: `c_${randomBytes(4).toString('hex')}`, is_custom: true, allows_custom_fields: true });
          return {
            seen: await visible(m, A1),
            insert: (await tryOn(m, counted(oSql), oParams)).code,
            update: await tryOn(m, counted(`UPDATE core.object_metadata SET label_plural = 'pwned' WHERE id = $1`), [A1.equipment]),
            delete: await tryOn(m, counted('DELETE FROM core.field_metadata_option WHERE workspace_id = $1'), [A1.workspace]),
          };
        });
        expect({ org: ctx.organisationId, ...r }).toEqual({ org: ctx.organisationId, seen: zero, insert: '42501', update: { code: null, constraint: null, n: 0 }, delete: { code: null, constraint: null, n: 0 } });
      }
    });

    it('MD-10 (3) no access to another workspace: its rows are unreadable, untouchable and cannot be created (same and other organisation)', async () => {
      const before = { a2: await countsOf(A2.workspace), b1: await countsOf(B1.workspace) };
      // I-4: the other workspaces really hold rows in every table, so "0 rows read / touched" below proves isolation, not emptiness
      for (const [tag, counts] of Object.entries(before)) {
        for (const tbl of METADATA_TABLES) expect({ tag, tbl, nonZero: counts[tbl]! > 0 }).toEqual({ tag, tbl, nonZero: true });
      }
      const others = [A2, B1];
      const ws = others.map((o) => o.workspace);
      const r = await requestRolledBack(ctxOf(A1.org, A1.workspace, A1.user), async (m) => {
        const reads: Record<string, number> = {};
        for (const tbl of METADATA_TABLES) reads[tbl] = ((await m.query(`SELECT count(*)::int AS n FROM core.${tbl} WHERE workspace_id = ANY($1::uuid[])`, [ws])) as Array<{ n: number }>)[0]!.n;
        reads.byId = ((await m.query('SELECT count(*)::int AS n FROM core.object_metadata WHERE id = ANY($1::uuid[])', [others.map((o) => o.equipment)])) as Array<{ n: number }>)[0]!.n;
        const updates = {
          object_metadata: await tryOn(m, counted(`UPDATE core.object_metadata SET label_plural = 'pwned' WHERE workspace_id = ANY($1::uuid[])`), [ws]),
          field_metadata: await tryOn(m, counted(`UPDATE core.field_metadata SET label = 'pwned' WHERE workspace_id = ANY($1::uuid[])`), [ws]),
          field_metadata_option: await tryOn(m, counted(`UPDATE core.field_metadata_option SET label = 'pwned' WHERE workspace_id = ANY($1::uuid[])`), [ws]),
          index_metadata: await tryOn(m, counted('UPDATE core.index_metadata SET is_active = false WHERE workspace_id = ANY($1::uuid[])'), [ws]),
          index_field_metadata: await tryOn(m, counted('UPDATE core.index_field_metadata SET position = 2 WHERE workspace_id = ANY($1::uuid[])'), [ws]),
        };
        const deletes: Record<string, unknown> = {};
        for (const tbl of [...METADATA_TABLES].reverse()) deletes[tbl] = await tryOn(m, counted(`DELETE FROM core.${tbl} WHERE workspace_id = ANY($1::uuid[])`), [ws]);
        const inserts: Record<string, string | null> = {};
        for (const o of others) {
          const t = { organisation_id: o.org, workspace_id: o.workspace };
          const [oSql, oParams] = objectInsert({ ...t, name_singular: 'smuggled', name_plural: 'smuggleds', label_singular: 'S', label_plural: 'S', physical_table: `c_${randomBytes(4).toString('hex')}`, is_custom: true, allows_custom_fields: true });
          const [fSql, fParams] = fieldInsert({ ...t, object_metadata_id: o.equipment, type: 'TEXT', name: 'smuggled', label: 'S', physical_column: 'cf_smuggled1', is_custom: true });
          inserts[`${o.tag}.object`] = (await tryOn(m, counted(oSql), oParams)).code;
          inserts[`${o.tag}.field`] = (await tryOn(m, counted(fSql), fParams)).code;
          inserts[`${o.tag}.option`] = (await tryOn(m, counted('INSERT INTO core.field_metadata_option (organisation_id, workspace_id, field_metadata_id, value, label) VALUES ($1, $2, $3, $4, $5)'), [o.org, o.workspace, o.equipmentSerial, 'smuggled', 'S'])).code;
          inserts[`${o.tag}.index`] = (await tryOn(m, counted('INSERT INTO core.index_metadata (organisation_id, workspace_id, object_metadata_id, physical_name) VALUES ($1, $2, $3, $4)'), [o.org, o.workspace, o.equipment, 'ix_smuggled1'])).code;
          inserts[`${o.tag}.indexField`] = (await tryOn(m, counted('INSERT INTO core.index_field_metadata (organisation_id, workspace_id, index_metadata_id, object_metadata_id, field_metadata_id, position) VALUES ($1, $2, $3, $4, $5, 1)'), [o.org, o.workspace, o.equipmentIndex, o.equipment, o.equipmentName])).code;
          // own tenant columns, the other workspace's parent: refused by the composite key / the guard's parent lookup
          const [xSql, xParams] = fieldInsert({ organisation_id: A1.org, workspace_id: A1.workspace, object_metadata_id: o.equipment, type: 'TEXT', name: 'crossRef', label: 'X', physical_column: 'cf_crossref1', is_custom: true });
          inserts[`${o.tag}.crossParent`] = (await tryOn(m, counted(xSql), xParams)).code;
        }
        // moving an own row into another workspace
        const move = (await tryOn(m, counted('UPDATE core.object_metadata SET workspace_id = $2, organisation_id = $3 WHERE id = $1'), [A1.equipment, A2.workspace, A2.org])).code;
        return { reads, updates, deletes, inserts, move };
      });
      const none = { code: null, constraint: null, n: 0 };
      expect(r.reads).toEqual({ ...Object.fromEntries(METADATA_TABLES.map((tbl) => [tbl, 0])), byId: 0 });
      expect(r.updates).toEqual(Object.fromEntries(METADATA_TABLES.map((tbl) => [tbl, none])));
      expect(r.deletes).toEqual(Object.fromEntries(METADATA_TABLES.map((tbl) => [tbl, none])));
      // An object row is refused by WITH CHECK (42501). A child row is refused before that by the guard's parent lookup or the
      // composite key: the parent is invisible under RLS, so it reads exactly like a parent that does not exist (23503).
      for (const o of others) {
        expect(r.inserts[`${o.tag}.object`]).toBe('42501');
        for (const k of ['field', 'option', 'index', 'indexField', 'crossParent']) expect({ k: `${o.tag}.${k}`, code: ['42501', '23503'].includes(String(r.inserts[`${o.tag}.${k}`])) }).toEqual({ k: `${o.tag}.${k}`, code: true });
      }
      expect(r.move).toBe('42501');
      // a mismatched binding (organisation B, workspace A1) sees nothing either
      const mismatched = await requestRolledBack(ctxOf(B1.org, A1.workspace, B1.user), (m) => visible(m, A1));
      expect(mismatched).toEqual(Object.fromEntries(METADATA_TABLES.map((tbl) => [tbl, { n: 0, foreign: 0 }])));
      expect({ a2: await countsOf(A2.workspace), b1: await countsOf(B1.workspace) }).toEqual(before);
      const label = await asAdmin(async (c) => (await c.query<{ l: string }>('SELECT label_plural AS l FROM core.object_metadata WHERE id = $1', [A2.equipment])).rows[0]!.l);
      expect(label).toBe('Equipment');
    });
  });

  // ------------------------------------------------------------------------------------------------------------ MD-6
  it('MD-6 deleting a workspace removes exactly its metadata (FK cascade passes the delete guard); the others stay', async () => {
    const a1 = await countsOf(A1.workspace);
    const b1 = await countsOf(B1.workspace);
    expect(Object.values(await countsOf(A2.workspace)).every((n) => n > 0)).toBe(true);
    await asAdmin((c) => c.query('DELETE FROM core.manager_workspace WHERE id = $1', [A2.workspace]));
    expect(Object.values(await countsOf(A2.workspace))).toEqual(METADATA_TABLES.map(() => 0));
    expect(await countsOf(A1.workspace)).toEqual(a1);
    expect(await countsOf(B1.workspace)).toEqual(b1);
  });
});
